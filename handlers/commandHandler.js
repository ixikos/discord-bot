const { REST, Routes, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, EmbedBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const messageHandler = require('./messageHandler');
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const CLICKUP_MCP_URL = 'https://mcp.clickup.com/mcp';
const MCP_BETA        = 'mcp-client-2025-11-20';

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
// Claude + ClickUp MCP: search for duplicates, create ticket if none found
// ---------------------------------------------------------------------------
async function checkDuplicateAndCreate(bug) {
  const systemPrompt = `You are a bug-triage assistant integrated with ClickUp for a game called Skydew Islands.

Steps:
1. Search ClickUp using 2-3 different focused keyword queries (2-3 words each) to find tasks similar to the bug report. Search the whole workspace, not just one list.
2. Decide if a duplicate exists.
3. If NO duplicate: create a new ClickUp task for this bug. Pick the most appropriate list based on context (e.g. current sprint backlog for active bugs).
4. Respond ONLY with a JSON object — no prose, no markdown fences:

{
  "isDuplicate": true | false,
  "confidence": "high" | "medium" | "low",
  "matchedTask": {
    "id": "task_id",
    "name": "task name",
    "url": "https://app.clickup.com/t/...",
    "status": "status string",
    "similarity": "one sentence why this matches"
  } | null,
  "createdTask": {
    "url": "https://app.clickup.com/t/..."
  } | null,
  "summary": "2-3 sentence analysis of what you found and what action was taken"
}

Rules:
- isDuplicate=true only when confidence is medium or high.
- If isDuplicate=true, do NOT create a new task. Set createdTask=null.
- If isDuplicate=false, CREATE the task and populate createdTask.url.
- When creating, use the bug priority field and include steps in the description if provided.`;

  const userContent = `Bug report:
Title: ${bug.title}
Priority: ${bug.priority || 'normal'}
Author: ${bug.author}
${bug.version ? `Build: ${bug.version}` : ''}
Description: ${bug.description}
${bug.steps ? `Steps to Reproduce:\n${bug.steps}` : ''}

Search ClickUp for duplicates across the whole workspace. If none found, create the ticket.`;

  const response = await anthropic.beta.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 1000,
    system:     systemPrompt,
    messages:   [{ role: 'user', content: userContent }],
    tools: [{ type: 'mcp_toolset', mcp_server_name: 'clickup' }],
    mcp_servers: [{
      type:                'url',
      url:                 CLICKUP_MCP_URL,
      name:                'clickup',
      authorization_token: process.env.CLICKUP_MCP_TOKEN,
    }],
    betas: [MCP_BETA],
  });

  const rawText = response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');

  try {
    return JSON.parse(rawText.replace(/```json|```/g, '').trim());
  } catch {
    console.error('Failed to parse Claude response:', rawText);
    return {
      isDuplicate: false,
      confidence:  'low',
      matchedTask: null,
      createdTask: null,
      summary:     'Could not analyse results — please check ClickUp manually.',
    };
  }
}

// "Create Anyway" button — bypass dupe check, create directly via MCP
async function createClickUpTicket(bug) {
  const response = await anthropic.beta.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 500,
    system:     'You are a ClickUp assistant. Create the task as described and respond ONLY with JSON: { "url": "https://app.clickup.com/t/..." }. No prose, no markdown.',
    messages:   [{
      role:    'user',
      content: `Create a ClickUp bug task in the most appropriate active list:
Title: ${bug.title}
Priority: ${bug.priority || 'normal'}
Description: ${bug.description}
${bug.steps ? `Steps:\n${bug.steps}` : ''}
Reported by: ${bug.author}`,
    }],
    tools: [{ type: 'mcp_toolset', mcp_server_name: 'clickup' }],
    mcp_servers: [{
      type:                'url',
      url:                 CLICKUP_MCP_URL,
      name:                'clickup',
      authorization_token: process.env.CLICKUP_MCP_TOKEN,
    }],
    betas: [MCP_BETA],
  });

  const rawText = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const parsed  = JSON.parse(rawText.replace(/```json|```/g, '').trim());
  return parsed.url;
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

module.exports = { register, handle };