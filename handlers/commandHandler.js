const { REST, Routes, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, EmbedBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const messageHandler = require('./messageHandler');
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ClickUp REST API — used directly since mcp.clickup.com requires browser OAuth
const CLICKUP_API = 'https://api.clickup.com/api/v2';

// "Bugs" list under Epics in Skydew Islands (override via CLICKUP_BUG_LIST_ID env var)
const CLICKUP_BUG_LIST_ID = process.env.CLICKUP_BUG_LIST_ID || '901113636608';

async function clickupSearch(keywords) {
  const res = await fetch(
    `${CLICKUP_API}/team/${process.env.CLICKUP_WORKSPACE_ID}/taskSearch?query=${encodeURIComponent(keywords)}&limit=5`,
    { headers: { Authorization: process.env.CLICKUP_API_KEY } }
  );
  if (!res.ok) {
    console.warn(`ClickUp search failed (${res.status}) for: ${keywords}`);
    return [];
  }
  const data = await res.json();
  return (data.tasks || []).map(t => ({
    id:     t.id,
    name:   t.name,
    status: t.status?.status ?? 'unknown',
    url:    `https://app.clickup.com/t/${t.id}`,
  }));
}

async function clickupCreateTask(bug) {
  const priorityMap = { urgent: 1, high: 2, normal: 3, low: 4 };
  const description = [
    bug.description,
    bug.steps     ? `\n\nSteps to Reproduce:\n${bug.steps}` : '',
    bug.version   ? `\n\nBuild: ${bug.version}` : '',
    bug.sourceUrl ? `\n\nSource: ${bug.sourceUrl}` : '',
    `\n\nReported by: ${bug.author}`,
  ].join('');

  const res = await fetch(`${CLICKUP_API}/list/${CLICKUP_BUG_LIST_ID}/task`, {
    method:  'POST',
    headers: { Authorization: process.env.CLICKUP_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name:     bug.title,
      description,
      priority: priorityMap[bug.priority] ?? 3,
      tags:     ['bug'],
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`ClickUp create failed ${res.status}: ${err}`);
  }
  const data = await res.json();
  return `https://app.clickup.com/t/${data.id}`;
}

// ---------------------------------------------------------------------------
// Define slash commands here — add new ones to this array
// ---------------------------------------------------------------------------
const commands = [
  {
    name: 'bugs',
    description: 'Show all pending bugs queued for EOD ticket creation',
  },
  {
    name: 'flush-bugs',
    description: 'Manually trigger EOD bug processing right now (admin only)',
  },
  {
    name: 'bug',
    description: 'Manually file a bug report as a ClickUp ticket immediately',
  },
];

async function register(client) {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(
      Routes.applicationGuildCommands(client.user.id, process.env.GUILD_ID),
      { body: commands }
    );
    console.log('✅ Slash commands registered');
  } catch (err) {
    console.error('Failed to register slash commands:', err);
  }
}

async function handle(interaction, client) {

  // ---------------------------------------------------------------------------
  // Slash commands
  // ---------------------------------------------------------------------------
  if (interaction.isChatInputCommand()) {
    switch (interaction.commandName) {

      case 'bugs': {
        const bugs = messageHandler.loadBugs();
        if (bugs.length === 0) {
          return interaction.reply({ content: 'No pending bugs queued.', ephemeral: true });
        }
        const lines = bugs.map((b, i) =>
          `**${i + 1}.** <@${b.author}> at ${new Date(b.timestamp).toLocaleTimeString()}: ${b.content.slice(0, 100)}`
        );
        return interaction.reply({
          content: `**${bugs.length} pending bug(s):**\n${lines.join('\n')}`,
          ephemeral: true,
        });
      }

      case 'flush-bugs': {
        // Only admins
        if (!interaction.member.permissions.has('Administrator')) {
          return interaction.reply({ content: 'Admin only.', ephemeral: true });
        }
        const bugs = messageHandler.loadBugs();
        if (bugs.length === 0) {
          return interaction.reply({ content: 'No bugs to flush.', ephemeral: true });
        }
        // Forward to n8n for processing
        await forwardBugsToN8n(bugs);
        messageHandler.clearBugs();
        return interaction.reply({ content: `✅ Sent ${bugs.length} bug(s) to n8n for processing.` });
      }

      case 'bug': {
        // Show a modal to fill in bug details
        const modal = new ModalBuilder()
          .setCustomId('bug_modal')
          .setTitle('File a Bug Report');

        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('title')
              .setLabel('Title')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('description')
              .setLabel('Description')
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(true)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('steps')
              .setLabel('Steps to Reproduce')
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(false)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('priority')
              .setLabel('Priority (low / normal / high / urgent)')
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
              .setValue('normal')
          ),
        );

        return interaction.showModal(modal);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Modal submissions
  // ---------------------------------------------------------------------------
  if (interaction.isModalSubmit()) {
    if (interaction.customId === 'bug_modal') {
      await interaction.deferReply({ ephemeral: true });

      const bug = {
        title:       interaction.fields.getTextInputValue('title'),
        description: interaction.fields.getTextInputValue('description'),
        steps:       interaction.fields.getTextInputValue('steps'),
        priority:    interaction.fields.getTextInputValue('priority') || 'normal',
        author:      interaction.user.username,
        timestamp:   new Date().toISOString(),
      };

      try {
        const result = await checkDuplicateAndCreate(bug);
        const embed  = buildResultEmbed(bug, result, interaction.user);
        const components = result.isDuplicate ? buildDuplicateButtons(bug, result) : [];
        await interaction.editReply({ embeds: [embed], components });
        await postPublicResult(bug, result, interaction.user, client);
      } catch (err) {
        console.error('Bug modal error:', err);
        await interaction.editReply(`❌ Failed to process bug report: ${err.message}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Button interactions
  // ---------------------------------------------------------------------------
  if (interaction.isButton()) {
    // file_bug button from build notification
    if (interaction.customId.startsWith('file_bug:')) {
      const [, buildId, version] = interaction.customId.split(':');

      const modal = new ModalBuilder()
        .setCustomId(`bug_modal_build:${buildId}:${version}`)
        .setTitle(`File Bug — Build ${version}`);

      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('title')
            .setLabel('Bug Title')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('description')
            .setLabel('Description')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
        ),
      );

      return interaction.showModal(modal);
    }
  }

  // Modal from build bug button
  if (interaction.isModalSubmit() && interaction.customId.startsWith('bug_modal_build:')) {
    const [, buildId, version] = interaction.customId.split(':');
    await interaction.deferReply({ ephemeral: true });

    const bug = {
      title:       interaction.fields.getTextInputValue('title'),
      description: interaction.fields.getTextInputValue('description'),
      buildId,
      version,
      author:    interaction.user.username,
      timestamp: new Date().toISOString(),
    };

    try {
      const result = await checkDuplicateAndCreate(bug);
      const embed  = buildResultEmbed(bug, result, interaction.user);
      const components = result.isDuplicate ? buildDuplicateButtons(bug, result) : [];
      await interaction.editReply({ embeds: [embed], components });
      await postPublicResult(bug, result, interaction.user, client);
    } catch (err) {
      console.error('Build bug modal error:', err);
      await interaction.editReply(`❌ Failed: ${err.message}`);
    }
  }
  // Button: "Create Anyway" after a duplicate was flagged
  if (interaction.isButton() && interaction.customId.startsWith('create_anyway:')) {
    await interaction.deferUpdate();
    const bugJson = Buffer.from(interaction.customId.split('create_anyway:')[1], 'base64').toString('utf8');
    const bug = JSON.parse(bugJson);

    try {
      const ticketUrl = await createClickUpTicket(bug);
      const createdResult = { isDuplicate: false, confidence: 'low', matchedTask: null, createdTask: { url: ticketUrl }, summary: 'Created despite possible duplicate.' };
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x57F287)
            .setTitle('✅ Ticket Created')
            .setDescription(`New ClickUp ticket filed despite possible duplicate.\n[View Ticket](${ticketUrl})`)
            .setTimestamp(),
        ],
        components: [],
      });
      await postPublicResult(bug, createdResult, interaction.user, client);
    } catch (err) {
      await interaction.editReply({ content: `❌ Failed to create ticket: ${err.message}`, components: [] });
    }
  }
}

// ---------------------------------------------------------------------------
// Search + dedupe via ClickUp REST, analysis via Claude text-only
// ---------------------------------------------------------------------------
async function checkDuplicateAndCreate(bug) {
  // Run 2-3 keyword searches in parallel
  const queries = buildSearchQueries(bug);
  const resultSets = await Promise.all(queries.map(q => clickupSearch(q)));

  // Dedupe by id
  const seen = new Map();
  for (const tasks of resultSets) for (const t of tasks) if (!seen.has(t.id)) seen.set(t.id, t);
  const candidates = [...seen.values()];

  if (candidates.length === 0) {
    const url = await clickupCreateTask(bug);
    return { isDuplicate: false, confidence: 'low', matchedTask: null, createdTask: { url },
      summary: `No similar tasks found across ${queries.length} searches. Ticket created.` };
  }

  // Ask Claude to analyse candidates — pure text, no tools needed
  const candidateSummary = candidates.map(t =>
    `- ID: ${t.id} | Status: ${t.status} | Name: ${t.name} | URL: ${t.url}`
  ).join('\n');

  const response = await anthropic.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 600,
    system: `You are a bug-triage assistant for a game called Skydew Islands.
Given a new bug report and a list of existing ClickUp tasks, decide if any is a genuine duplicate.
Respond ONLY with JSON — no prose, no markdown fences:
{
  "isDuplicate": true | false,
  "confidence": "high" | "medium" | "low",
  "matchedTaskId": "id or null",
  "matchedTaskName": "name or null",
  "matchedTaskUrl": "url or null",
  "matchedTaskStatus": "status or null",
  "similarity": "one sentence why it matches, or null",
  "summary": "2-3 sentence explanation"
}
Rules: isDuplicate=true only for medium or high confidence genuine matches — not just same topic.`,
    messages: [{ role: 'user', content:
      `New bug:\nTitle: ${bug.title}\nDescription: ${bug.description}${bug.steps ? '\nSteps: ' + bug.steps : ''}\n\nExisting tasks:\n${candidateSummary}\n\nIs any a duplicate?`
    }],
  });

  const rawText = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
  let analysis;
  try {
    analysis = JSON.parse(rawText.replace(/```json|```/g, '').trim());
  } catch {
    console.error('Claude parse error:', rawText);
    const url = await clickupCreateTask(bug);
    return { isDuplicate: false, confidence: 'low', matchedTask: null, createdTask: { url }, summary: 'Analysis inconclusive. Ticket created.' };
  }

  if (analysis.isDuplicate) {
    return {
      isDuplicate: true, confidence: analysis.confidence,
      matchedTask: { id: analysis.matchedTaskId, name: analysis.matchedTaskName,
        url: analysis.matchedTaskUrl, status: analysis.matchedTaskStatus, similarity: analysis.similarity },
      createdTask: null, summary: analysis.summary,
    };
  }

  const url = await clickupCreateTask(bug);
  return { isDuplicate: false, confidence: analysis.confidence, matchedTask: null, createdTask: { url }, summary: analysis.summary };
}

// Build 2-3 focused keyword queries from the bug report
function buildSearchQueries(bug) {
  const clean = s => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
    .filter(w => w.length > 3 && !['with','when','that','this','from','have','been','they','just','only','also','into','does'].includes(w));
  const titleWords = clean(bug.title);
  const descWords  = clean(bug.description);
  const q1 = titleWords.slice(0, 3).join(' ');
  const q2 = [...new Set([...titleWords, ...descWords])].slice(2, 5).join(' ');
  const q3 = [titleWords[0], ...descWords.slice(0, 2)].filter(Boolean).join(' ');
  return [...new Set([q1, q2, q3].filter(q => q.trim().length > 3))];
}

// "Create Anyway" — skip dupe check, create directly
async function createClickUpTicket(bug) {
  return clickupCreateTask(bug);
}

// ---------------------------------------------------------------------------
// Embed + button builders
// ---------------------------------------------------------------------------
function buildResultEmbed(bug, result, user) {
  const priorityEmoji = { urgent: '🔴', high: '🟠', normal: '🟡', low: '🟢' }[bug.priority] ?? '⚪';

  if (result.isDuplicate && result.matchedTask) {
    const confidenceEmoji = { high: '🎯', medium: '🔍', low: '🤔' }[result.confidence] ?? '🔍';
    return new EmbedBuilder()
      .setColor(0xE74C3C)
      .setTitle('⚠️ Possible Duplicate Bug')
      .setDescription(`**Analysis:** ${result.summary}`)
      .addFields(
        { name: `${priorityEmoji} Your Report`, value: `**${bug.title}**\n${bug.description.slice(0, 200)}${bug.description.length > 200 ? '…' : ''}` },
        {
          name: `${confidenceEmoji} Existing Ticket (${result.confidence} confidence)`,
          value: `**[${result.matchedTask.name}](${result.matchedTask.url})**\nStatus: \`${result.matchedTask.status}\`\n${result.matchedTask.similarity}`,
        },
      )
      .setFooter({ text: 'This is only visible to you — use the buttons below' })
      .setTimestamp();
  }

  return new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle('✅ Bug Ticket Created')
    .setDescription(`**Analysis:** ${result.summary}`)
    .addFields(
      { name: `${priorityEmoji} Bug`, value: `**${bug.title}**` },
      { name: 'ClickUp', value: result.createdTask?.url ? `[View Ticket](${result.createdTask.url})` : 'Created (URL unavailable)', inline: true },
      { name: 'Priority', value: `${priorityEmoji} ${bug.priority || 'normal'}`, inline: true },
    )
    .setTimestamp();
}

function buildDuplicateButtons(bug, result) {
  // Encode the bug as base64 so we can recover it in the button handler
  const bugEncoded = Buffer.from(JSON.stringify(bug)).toString('base64');
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('View Existing Ticket')
      .setStyle(ButtonStyle.Link)
      .setURL(result.matchedTask.url)
      .setEmoji('🔗'),
    new ButtonBuilder()
      .setCustomId(`create_anyway:${bugEncoded}`)
      .setLabel('Create Anyway')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('🆕'),
  );
  return [row];
}

// ---------------------------------------------------------------------------
// Public channel post — visible to everyone in BUGS_CHANNEL_ID
// ---------------------------------------------------------------------------
async function postPublicResult(bug, result, user, client) {
  const channel = await client.channels.fetch(process.env.BUGS_CHANNEL_ID).catch(() => null);
  if (!channel) return;
  const embed      = buildPublicEmbed(bug, result, user);
  const components = result.isDuplicate ? buildDuplicateButtons(bug, result) : [];
  await channel.send({ embeds: [embed], components });
}

function buildPublicEmbed(bug, result, user) {
  const priorityEmoji = { urgent: '🔴', high: '🟠', normal: '🟡', low: '🟢' }[bug.priority] ?? '⚪';
  const reporter = `<@${user.id}>`;

  if (result.isDuplicate && result.matchedTask) {
    const confidenceEmoji = { high: '🎯', medium: '🔍', low: '🤔' }[result.confidence] ?? '🔍';
    return new EmbedBuilder()
      .setColor(0xFFA500)
      .setTitle('⚠️ Duplicate Bug Report')
      .setDescription(`${reporter} reported a bug that may already be tracked.`)
      .addFields(
        { name: `${priorityEmoji} Reported`, value: `**${bug.title}**\n${bug.description.slice(0, 200)}${bug.description.length > 200 ? '…' : ''}` },
        {
          name:  `${confidenceEmoji} Existing Ticket (${result.confidence} confidence)`,
          value: `**[${result.matchedTask.name}](${result.matchedTask.url})**\nStatus: \`${result.matchedTask.status}\`\n${result.matchedTask.similarity}`,
        },
      )
      .setFooter({ text: `Reported by ${user.username} · Use "Create Anyway" if this is a distinct issue` })
      .setTimestamp();
  }

  return new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle('🐛 New Bug Ticket Created')
    .setDescription(`${reporter} filed a new bug report.`)
    .addFields(
      { name: `${priorityEmoji} ${bug.title}`, value: bug.description.slice(0, 300) + (bug.description.length > 300 ? '…' : '') },
      { name: 'ClickUp', value: result.createdTask?.url ? `[View Ticket](${result.createdTask.url})` : 'Created', inline: true },
      { name: 'Priority', value: `${priorityEmoji} ${bug.priority || 'normal'}`, inline: true },
      ...(bug.version ? [{ name: 'Build', value: bug.version, inline: true }] : []),
    )
    .setTimestamp();
}

// ---------------------------------------------------------------------------
// Legacy n8n forwarder — kept for flush-bugs EOD batch
// ---------------------------------------------------------------------------
async function forwardBugsToN8n(bugs, immediate = false) {
  const url = immediate
    ? process.env.N8N_IMMEDIATE_WEBHOOK_URL
    : process.env.N8N_EOD_WEBHOOK_URL;

  if (!url) throw new Error('n8n webhook URL not configured in .env');

  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ bugs }),
  });

  if (!res.ok) throw new Error(`n8n responded with ${res.status}`);
}

// ---------------------------------------------------------------------------
// Bug reaction handler — triggered when someone reacts with 🐛
// ---------------------------------------------------------------------------
async function handleBugReaction(message, user, client) {
  // Ignore empty messages (image-only etc)
  if (!message.content || message.content.trim().length < 10) {
    await message.reply(`<@${user.id}> ⚠️ That message doesn't have enough text to file a bug from. Try the \`/bug\` command instead.`);
    return;
  }

  // Prevent duplicate processing — check if bot already reacted with ✅ or 🔄
  const alreadyProcessed = message.reactions.cache.some(
    r => (r.emoji.name === '✅' || r.emoji.name === '🔄') && r.users.cache.has(client.user.id)
  );
  if (alreadyProcessed) return;

  // Acknowledge immediately so user knows it's working
  await message.react('🔄').catch(() => {});

  const bug = {
    title:       inferTitle(message.content),
    description: message.content,
    steps:       null,
    priority:    'normal',
    author:      message.author.username,
    timestamp:   message.createdAt.toISOString(),
    sourceUrl:   message.url,
  };

  try {
    const result = await checkDuplicateAndCreate(bug);

    // Replace 🔄 with ✅
    await message.reactions.cache.get('🔄')?.remove().catch(() => {});
    await message.react('✅').catch(() => {});

    // Reply in the same channel so it's in context
    const embed = buildPublicEmbed(bug, result, message.author);
    const components = result.isDuplicate ? buildDuplicateButtons(bug, result) : [];
    await message.reply({ embeds: [embed], components });

    // Also post to bugs channel if this isn't already it
    if (message.channelId !== process.env.BUGS_CHANNEL_ID) {
      await postPublicResult(bug, result, message.author, client);
    }
  } catch (err) {
    console.error('handleBugReaction error:', err);
    await message.reactions.cache.get('🔄')?.remove().catch(() => {});
    await message.react('❌').catch(() => {});
    await message.reply(`<@${user.id}> ❌ Failed to process bug: ${err.message}`);
  }
}

// Infer a short title from the first sentence / first ~80 chars of content
function inferTitle(content) {
  const firstSentence = content.split(/[.!?\n]/)[0].trim();
  if (firstSentence.length >= 10 && firstSentence.length <= 100) return firstSentence;
  return content.slice(0, 80).trim() + (content.length > 80 ? '…' : '');
}

module.exports = { register, handle, handleBugReaction };