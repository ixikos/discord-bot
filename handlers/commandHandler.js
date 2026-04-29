const { REST, Routes, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, EmbedBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const messageHandler = require('./messageHandler');
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ClickUp REST API
const CLICKUP_API = 'https://api.clickup.com/api/v2';

// Workspace list map — Claude uses this to suggest where to file bugs.
// Filtered to lists meaningful for bug/task triage (excludes archive/weekly noise).
const CLICKUP_LISTS = [
  { id: '901113636608', name: 'Bugs',                          folder: 'Epics' },
  { id: '901113636505', name: '4/19 - 5/3 (Active Sprint)',    folder: 'Sprints' },
  { id: '901113604581', name: 'Catchall',                      folder: 'Epics' },
  { id: '901112286095', name: 'Inventory / Chests / Collectibles', folder: 'Epics' },
  { id: '901113636599', name: 'Player Movement and Interaction', folder: 'Epics' },
  { id: '901113636661', name: 'UI',                            folder: 'Epics' },
  { id: '901113636658', name: 'Client Networking',             folder: 'Epics' },
  { id: '901112260707', name: 'Gameplay Loops',                folder: 'Epics' },
  { id: '901111865228', name: 'Base Building Epic',            folder: 'Epics' },
  { id: '901112531922', name: 'Mutators',                      folder: 'Epics' },
  { id: '901113027450', name: 'Beacon Quests',                 folder: 'Epics' },
  { id: '901106528870', name: 'Movement',                      folder: 'Core Systems' },
  { id: '901106458516', name: 'Validity',                      folder: 'Core Systems' },
  { id: '901113682512', name: 'Spreadsheet Import',            folder: 'Skydew Islands' },
  { id: '901113636653', name: 'Editor Tooling and QoL',        folder: 'Epics' },
];

// Use OAuth token for MCP-quality search, personal API key for creates
function clickupAuthHeader() {
  return process.env.CLICKUP_OAUTH_TOKEN
    ? `Bearer ${process.env.CLICKUP_OAUTH_TOKEN}`
    : process.env.CLICKUP_API_KEY;
}

async function clickupSearch(keywords) {
  const res = await fetch(
    `${CLICKUP_API}/team/${process.env.CLICKUP_WORKSPACE_ID}/taskSearch?query=${encodeURIComponent(keywords)}&limit=5`,
    { headers: { Authorization: clickupAuthHeader() } }
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

async function clickupCreateTask(bug, listId) {
  const priorityMap = { urgent: 1, high: 2, normal: 3, low: 4 };
  const description = [
    bug.description,
    bug.steps     ? `\n\nSteps to Reproduce:\n${bug.steps}` : '',
    bug.version   ? `\n\nBuild: ${bug.version}` : '',
    bug.sourceUrl ? `\n\nSource: ${bug.sourceUrl}` : '',
    `\n\nReported by: ${bug.author}`,
  ].join('');

  const res = await fetch(`${CLICKUP_API}/list/${listId}/task`, {
    method:  'POST',
    headers: { Authorization: clickupAuthHeader(), 'Content-Type': 'application/json' },
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
        const result = await checkDuplicate(bug);
        if (result.isDuplicate) {
          const embed = buildDuplicateEmbed(bug, result, interaction.user);
          await interaction.editReply({ embeds: [embed], components: buildDuplicateButtons(bug, result) });
          await postPublicResult(bug, result, interaction.user, client);
        } else {
          const { embed, components } = await buildListPickerEmbed(bug, result, interaction.user);
          await interaction.editReply({ embeds: [embed], components });
        }
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
      const result = await checkDuplicate(bug);
      if (result.isDuplicate) {
        const embed = buildDuplicateEmbed(bug, result, interaction.user);
        await interaction.editReply({ embeds: [embed], components: buildDuplicateButtons(bug, result) });
        await postPublicResult(bug, result, interaction.user, client);
      } else {
        const { embed, components } = await buildListPickerEmbed(bug, result, interaction.user);
        await interaction.editReply({ embeds: [embed], components });
      }
    } catch (err) {
      console.error('Build bug modal error:', err);
      await interaction.editReply(`❌ Failed: ${err.message}`);
    }
  }
  // Button: "Create Anyway" after a duplicate was flagged
  // "Create Anyway" after duplicate warning — show list picker instead of auto-creating
  if (interaction.isButton() && interaction.customId.startsWith('create_anyway:')) {
    await interaction.deferUpdate();
    const bugJson = Buffer.from(interaction.customId.split('create_anyway:')[1], 'base64').toString('utf8');
    const bug = JSON.parse(bugJson);
    try {
      const { embed, components } = await buildListPickerEmbed(bug, null, interaction.user);
      await interaction.editReply({ embeds: [embed], components });
    } catch (err) {
      await interaction.editReply({ content: `❌ Failed: ${err.message}`, components: [] });
    }
  }

  // User picked a list from the picker — create the ticket there
  if (interaction.isButton() && interaction.customId.startsWith('create_in:')) {
    await interaction.deferUpdate();
    const [, listId, bugEncoded] = interaction.customId.split(':');
    const bug = JSON.parse(Buffer.from(bugEncoded, 'base64').toString('utf8'));
    const list = CLICKUP_LISTS.find(l => l.id === listId);
    try {
      const url = await clickupCreateTask(bug, listId);
      const createdResult = { isDuplicate: false, matchedTask: null, createdTask: { url }, summary: `Ticket created in **${list?.name ?? listId}**.` };
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x57F287)
            .setTitle('✅ Bug Ticket Created')
            .setDescription(`Filed in **${list?.name ?? listId}** (${list?.folder ?? ''})`)
            .addFields({ name: bug.title, value: `[View Ticket](${url})` })
            .setTimestamp(),
        ],
        components: [],
      });
      await postPublicResult(bug, createdResult, interaction.user, client);
    } catch (err) {
      await interaction.editReply({ content: `❌ Failed to create ticket: ${err.message}`, components: [] });
    }
  }

  // "Other list…" — show paginated full list browser
  if (interaction.isButton() && interaction.customId.startsWith('browse_lists:')) {
    await interaction.deferUpdate();
    const { bug, page } = JSON.parse(Buffer.from(interaction.customId.split('browse_lists:')[1], 'base64').toString('utf8'));
    const pageSize = 4;
    const start = page * pageSize;
    const pageLists = CLICKUP_LISTS.slice(start, start + pageSize);
    const bugEncoded = Buffer.from(JSON.stringify(bug)).toString('base64');

    const buttons = pageLists.map(l =>
      new ButtonBuilder()
        .setCustomId(`create_in:${l.id}:${bugEncoded}`)
        .setLabel(l.name.length > 25 ? l.name.slice(0, 23) + '…' : l.name)
        .setStyle(ButtonStyle.Secondary)
    );

    // Add prev/next navigation
    const navRow = new ActionRowBuilder();
    if (page > 0) {
      const prevEncoded = Buffer.from(JSON.stringify({ bug, page: page - 1 })).toString('base64');
      navRow.addComponents(new ButtonBuilder().setCustomId(`browse_lists:${prevEncoded}`).setLabel('← Back').setStyle(ButtonStyle.Secondary));
    }
    if (start + pageSize < CLICKUP_LISTS.length) {
      const nextEncoded = Buffer.from(JSON.stringify({ bug, page: page + 1 })).toString('base64');
      navRow.addComponents(new ButtonBuilder().setCustomId(`browse_lists:${nextEncoded}`).setLabel('More →').setStyle(ButtonStyle.Secondary));
    }

    const rows = [new ActionRowBuilder().addComponents(...buttons)];
    if (navRow.components.length > 0) rows.push(navRow);

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('📂 Choose a list')
      .setDescription(pageLists.map(l => `**${l.name}** · ${l.folder}`).join('\n'))
      .setFooter({ text: `Page ${page + 1} of ${Math.ceil(CLICKUP_LISTS.length / pageSize)}` });

    await interaction.editReply({ embeds: [embed], components: rows });
  }
}

// ---------------------------------------------------------------------------
// Step 1: Check for duplicates only — never auto-creates
// ---------------------------------------------------------------------------
async function checkDuplicate(bug) {
  const queries = buildSearchQueries(bug);
  const resultSets = await Promise.all(queries.map(q => clickupSearch(q)));

  const seen = new Map();
  for (const tasks of resultSets) for (const t of tasks) if (!seen.has(t.id)) seen.set(t.id, t);
  const candidates = [...seen.values()];

  if (candidates.length === 0) {
    return { isDuplicate: false, confidence: 'low', matchedTask: null, summary: 'No similar tasks found.' };
  }

  const candidateSummary = candidates.map(t =>
    `- ID: ${t.id} | Status: ${t.status} | Name: ${t.name} | URL: ${t.url}`
  ).join('\n');

  const response = await anthropic.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 500,
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
isDuplicate=true only for medium or high confidence genuine matches.`,
    messages: [{ role: 'user', content:
      `New bug:\nTitle: ${bug.title}\nDescription: ${bug.description}${bug.steps ? '\nSteps: ' + bug.steps : ''}\n\nExisting tasks:\n${candidateSummary}\n\nIs any a duplicate?`
    }],
  });

  const rawText = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
  try {
    const a = JSON.parse(rawText.replace(/```json|```/g, '').trim());
    if (a.isDuplicate) {
      return { isDuplicate: true, confidence: a.confidence, summary: a.summary,
        matchedTask: { id: a.matchedTaskId, name: a.matchedTaskName, url: a.matchedTaskUrl, status: a.matchedTaskStatus, similarity: a.similarity } };
    }
    return { isDuplicate: false, confidence: a.confidence, matchedTask: null, summary: a.summary };
  } catch {
    console.error('Claude parse error:', rawText);
    return { isDuplicate: false, confidence: 'low', matchedTask: null, summary: 'Analysis inconclusive.' };
  }
}

// ---------------------------------------------------------------------------
// Step 2: Ask Claude to suggest 3 lists from CLICKUP_LISTS for this bug
// ---------------------------------------------------------------------------
async function suggestLists(bug) {
  const listContext = CLICKUP_LISTS.map(l => `- ${l.id}: ${l.name} (${l.folder})`).join('\n');

  const response = await anthropic.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 300,
    system: `You are a project management assistant for a game called Skydew Islands.
Given a bug report, suggest the 3 most appropriate ClickUp lists to file it in, ordered by best fit.
Respond ONLY with JSON — no prose, no markdown fences:
{ "suggestions": [ { "id": "list_id", "reason": "one short phrase why" }, ... ] }
Return exactly 3 suggestions using only IDs from the provided list.`,
    messages: [{ role: 'user', content:
      `Bug: ${bug.title}\n${bug.description}\n\nAvailable lists:\n${listContext}\n\nSuggest 3 lists.`
    }],
  });

  const rawText = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
  try {
    const { suggestions } = JSON.parse(rawText.replace(/```json|```/g, '').trim());
    return suggestions
      .map(s => ({ ...CLICKUP_LISTS.find(l => l.id === s.id), reason: s.reason }))
      .filter(s => s.id);
  } catch {
    // Fallback: return top 3 most relevant hardcoded defaults
    return [
      { ...CLICKUP_LISTS.find(l => l.id === '901113636608'), reason: 'General bug tracker' },
      { ...CLICKUP_LISTS.find(l => l.id === '901113636505'), reason: 'Active sprint' },
      { ...CLICKUP_LISTS.find(l => l.id === '901113604581'), reason: 'Catchall' },
    ];
  }
}

// Build 2-3 focused keyword queries
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

// ---------------------------------------------------------------------------
// Embed + button builders
// ---------------------------------------------------------------------------
function buildDuplicateEmbed(bug, result, user) {
  const priorityEmoji = { urgent: '🔴', high: '🟠', normal: '🟡', low: '🟢' }[bug.priority] ?? '⚪';
  const confidenceEmoji = { high: '🎯', medium: '🔍', low: '🤔' }[result.confidence] ?? '🔍';
  return new EmbedBuilder()
    .setColor(0xE74C3C)
    .setTitle('⚠️ Possible Duplicate Bug')
    .setDescription(`**Analysis:** ${result.summary}`)
    .addFields(
      { name: `${priorityEmoji} Your Report`, value: `**${bug.title}**\n${bug.description.slice(0, 200)}${bug.description.length > 200 ? '…' : ''}` },
      { name: `${confidenceEmoji} Existing Ticket (${result.confidence} confidence)`,
        value: `**[${result.matchedTask.name}](${result.matchedTask.url})**\nStatus: \`${result.matchedTask.status}\`\n${result.matchedTask.similarity}` },
    )
    .setFooter({ text: 'Only visible to you — create anyway if this is a distinct issue' })
    .setTimestamp();
}

function buildDuplicateButtons(bug, result) {
  const bugEncoded = Buffer.from(JSON.stringify(bug)).toString('base64');
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('View Existing Ticket').setStyle(ButtonStyle.Link).setURL(result.matchedTask.url).setEmoji('🔗'),
    new ButtonBuilder().setCustomId(`create_anyway:${bugEncoded}`).setLabel('Create Anyway').setStyle(ButtonStyle.Secondary).setEmoji('🆕'),
  )];
}

async function buildListPickerEmbed(bug, result, user) {
  const priorityEmoji = { urgent: '🔴', high: '🟠', normal: '🟡', low: '🟢' }[bug.priority] ?? '⚪';
  const suggestions = await suggestLists(bug);
  const bugEncoded  = Buffer.from(JSON.stringify(bug)).toString('base64');

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('📋 Where should this bug go?')
    .setDescription(`No duplicate found for **${bug.title}**\nPick a list to file it in:`)
    .addFields(
      suggestions.map((s, i) => ({
        name:   `${['1️⃣','2️⃣','3️⃣'][i]} ${s.name}`,
        value:  `*${s.folder}* · ${s.reason}`,
        inline: false,
      }))
    )
    .setFooter({ text: 'Only visible to you' })
    .setTimestamp();

  const buttons = suggestions.map((s, i) =>
    new ButtonBuilder()
      .setCustomId(`create_in:${s.id}:${bugEncoded}`)
      .setLabel(s.name.length > 25 ? s.name.slice(0, 23) + '…' : s.name)
      .setStyle([ButtonStyle.Primary, ButtonStyle.Secondary, ButtonStyle.Secondary][i])
      .setEmoji(['1️⃣','2️⃣','3️⃣'][i])
  );

  const browseEncoded = Buffer.from(JSON.stringify({ bug, page: 0 })).toString('base64');
  buttons.push(
    new ButtonBuilder()
      .setCustomId(`browse_lists:${browseEncoded}`)
      .setLabel('Other list…')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('📂')
  );

  return { embed, components: [new ActionRowBuilder().addComponents(...buttons)] };
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
    const result = await checkDuplicate(bug);

    await message.reactions.cache.get('🔄')?.remove().catch(() => {});
    await message.react('✅').catch(() => {});

    if (result.isDuplicate) {
      const embed = buildDuplicateEmbed(bug, result, message.author);
      await message.reply({ embeds: [embed], components: buildDuplicateButtons(bug, result) });
      if (message.channelId !== process.env.BUGS_CHANNEL_ID) {
        await postPublicResult(bug, result, message.author, client);
      }
    } else {
      // Show list picker as a reply — ephemeral not available outside interactions,
      // so we send it as a normal reply and note it's for the reporter
      const { embed, components } = await buildListPickerEmbed(bug, result, message.author);
      embed.setDescription(`<@${message.author.id}> no duplicate found for **${bug.title}** — pick a list to file it in:`);
      await message.reply({ embeds: [embed], components });
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