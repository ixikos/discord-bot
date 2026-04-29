const { REST, Routes, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, EmbedBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const messageHandler = require('./messageHandler');
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ---------------------------------------------------------------------------
// In-memory bug store — avoids Discord's 100-char customId limit.
// Bugs are keyed by a short random ID and expire after 30 minutes.
// ---------------------------------------------------------------------------
const _bugStore = new Map();
const BUG_TTL_MS = 30 * 60 * 1000;

function storeBug(bug) {
  const id = Math.random().toString(36).slice(2, 10); // 8-char key e.g. "k3x9mq2z"
  _bugStore.set(id, { bug, expires: Date.now() + BUG_TTL_MS });
  // Purge expired entries opportunistically
  for (const [k, v] of _bugStore) if (Date.now() > v.expires) _bugStore.delete(k);
  return id;
}

function retrieveBug(id) {
  const entry = _bugStore.get(id);
  if (!entry) return null;
  if (Date.now() > entry.expires) { _bugStore.delete(id); return null; }
  return entry.bug;
}

// ClickUp REST API
const CLICKUP_API = 'https://api.clickup.com/api/v2';

// Folders to exclude from list picker — archive/historical noise
const EXCLUDED_FOLDERS = ['sprint archive', 'weeklys', 'archive', 'cleanup'];

// Use OAuth token for MCP-quality search, personal API key fallback
function clickupAuthHeader() {
  return process.env.CLICKUP_OAUTH_TOKEN
    ? `Bearer ${process.env.CLICKUP_OAUTH_TOKEN}`
    : process.env.CLICKUP_API_KEY;
}

// ---------------------------------------------------------------------------
// Workspace list cache — fetched on startup, refreshed every hour or on demand
// ---------------------------------------------------------------------------
let _listCache = [];
let _listCacheTime = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

async function getWorkspaceLists(force = false) {
  if (!force && _listCache.length > 0 && Date.now() - _listCacheTime < CACHE_TTL_MS) {
    return _listCache;
  }

  console.log('🔄 Fetching ClickUp workspace hierarchy...');
  const lists = [];

  try {
    // Fetch all spaces
    const spacesRes = await fetch(
      `${CLICKUP_API}/team/${process.env.CLICKUP_WORKSPACE_ID}/space?archived=false`,
      { headers: { Authorization: clickupAuthHeader() } }
    );
    if (!spacesRes.ok) throw new Error(`Spaces fetch failed: ${spacesRes.status}`);
    const { spaces } = await spacesRes.json();

    for (const space of spaces) {
      // Folderless lists in this space
      const flRes = await fetch(
        `${CLICKUP_API}/space/${space.id}/list?archived=false`,
        { headers: { Authorization: clickupAuthHeader() } }
      );
      if (flRes.ok) {
        const { lists: fl } = await flRes.json();
        for (const l of (fl || [])) {
          lists.push({ id: l.id, name: l.name, folder: space.name, space: space.name });
        }
      }

      // Folders → lists
      const fRes = await fetch(
        `${CLICKUP_API}/space/${space.id}/folder?archived=false`,
        { headers: { Authorization: clickupAuthHeader() } }
      );
      if (!fRes.ok) continue;
      const { folders } = await fRes.json();

      for (const folder of (folders || [])) {
        // Skip noisy archive/historical folders
        if (EXCLUDED_FOLDERS.some(ex => folder.name.toLowerCase().includes(ex))) continue;

        const lRes = await fetch(
          `${CLICKUP_API}/folder/${folder.id}/list?archived=false`,
          { headers: { Authorization: clickupAuthHeader() } }
        );
        if (!lRes.ok) continue;
        const { lists: fl } = await lRes.json();
        for (const l of (fl || [])) {
          lists.push({ id: l.id, name: l.name, folder: folder.name, space: space.name });
        }
      }
    }

    _listCache = lists;
    _listCacheTime = Date.now();
    console.log(`✅ Cached ${lists.length} ClickUp lists`);
  } catch (err) {
    console.error('Failed to fetch workspace lists:', err.message);
    // Return stale cache if available, otherwise empty
    if (_listCache.length > 0) {
      console.warn('Using stale list cache');
      return _listCache;
    }
  }

  return _listCache;
}

// clickupSearch is no longer used — search now goes through Claude+MCP in checkDuplicate

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
  {
    name: 'refresh-lists',
    description: 'Force refresh the cached ClickUp workspace lists (admin only)',
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

      case 'refresh-lists': {
        if (!interaction.member.permissions.has('Administrator')) {
          return interaction.reply({ content: 'Admin only.', ephemeral: true });
        }
        await interaction.deferReply({ ephemeral: true });
        const lists = await getWorkspaceLists(true);
        return interaction.editReply(`✅ Refreshed — ${lists.length} lists cached from ClickUp.`);
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
    const bugId = interaction.customId.split('create_anyway:')[1];
    const bug = retrieveBug(bugId);
    if (!bug) return interaction.editReply({ content: '❌ Bug report expired — please resubmit.', components: [] });
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
    const [, listId, bugId] = interaction.customId.split(':');
    const bug = retrieveBug(bugId);
    if (!bug) return interaction.editReply({ content: '❌ Bug report expired — please resubmit.', components: [] });
    const lists = await getWorkspaceLists();
    const list = lists.find(l => l.id === listId);
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
    const storeId = interaction.customId.split('browse_lists:')[1];
    const stored = retrieveBug(storeId);
    if (!stored) return interaction.editReply({ content: '❌ Session expired — please resubmit the bug.', components: [] });
    const { bug, page } = stored;
    const allLists = await getWorkspaceLists();
    const pageSize = 4;
    const start = page * pageSize;
    const pageLists = allLists.slice(start, start + pageSize);
    const bugId = storeBug(bug);

    const buttons = pageLists.map(l =>
      new ButtonBuilder()
        .setCustomId(`create_in:${l.id}:${bugId}`)
        .setLabel(l.name.length > 25 ? l.name.slice(0, 23) + '…' : l.name)
        .setStyle(ButtonStyle.Secondary)
    );

    // Add prev/next navigation
    const navRow = new ActionRowBuilder();
    if (page > 0) {
      const prevId = storeBug({ bug, page: page - 1 });
      navRow.addComponents(new ButtonBuilder().setCustomId(`browse_lists:${prevId}`).setLabel('← Back').setStyle(ButtonStyle.Secondary));
    }
    if (start + pageSize < allLists.length) {
      const nextId = storeBug({ bug, page: page + 1 });
      navRow.addComponents(new ButtonBuilder().setCustomId(`browse_lists:${nextId}`).setLabel('More →').setStyle(ButtonStyle.Secondary));
    }

    const rows = [new ActionRowBuilder().addComponents(...buttons)];
    if (navRow.components.length > 0) rows.push(navRow);

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('📂 Choose a list')
      .setDescription(pageLists.map(l => `**${l.name}** · ${l.folder}`).join('\n'))
      .setFooter({ text: `Page ${page + 1} of ${Math.ceil(allLists.length / pageSize)}` });

    await interaction.editReply({ embeds: [embed], components: rows });
  }
}

// ---------------------------------------------------------------------------
// Step 1: Check for duplicates via Claude + ClickUp MCP (full search quality)
// ---------------------------------------------------------------------------
const CLICKUP_MCP_URL = 'https://mcp.clickup.com/mcp';
const MCP_BETA        = 'mcp-client-2025-11-20';

function mcpServers() {
  return [{
    type:                'url',
    url:                 CLICKUP_MCP_URL,
    name:                'clickup',
    authorization_token: process.env.CLICKUP_OAUTH_TOKEN,
  }];
}

async function checkDuplicate(bug) {
  const response = await anthropic.beta.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 800,
    system: `You are a bug-triage assistant for a game called Skydew Islands.
Search ClickUp using 2-3 focused keyword queries to find tasks similar to the bug report.
Then decide if a genuine duplicate exists.
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
isDuplicate=true only for medium or high confidence genuine matches — not just same topic.`,
    messages: [{ role: 'user', content:
      `Bug report to check:\nTitle: ${bug.title}\nDescription: ${bug.description}${bug.steps ? '\nSteps: ' + bug.steps : ''}\n\nSearch ClickUp for duplicates and return your analysis as JSON.`
    }],
    tools:       [{ type: 'mcp_toolset', mcp_server_name: 'clickup' }],
    mcp_servers: mcpServers(),
    betas:       [MCP_BETA],
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
    console.error('Claude/MCP parse error:', rawText);
    return { isDuplicate: false, confidence: 'low', matchedTask: null, summary: 'Analysis inconclusive.' };
  }
}

// ---------------------------------------------------------------------------
// Step 2: Ask Claude to suggest 3 lists from live workspace cache for this bug
// ---------------------------------------------------------------------------
async function suggestLists(bug) {
  const lists = await getWorkspaceLists();
  const listContext = lists.map(l => `- ${l.id}: ${l.name} (${l.folder}, ${l.space})`).join('\n');

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
      .map(s => ({ ...lists.find(l => l.id === s.id), reason: s.reason }))
      .filter(s => s?.id);
  } catch {
    const bugsList = lists.find(l => l.name.toLowerCase() === 'bugs');
    const fallback = [bugsList, ...lists.filter(l => l !== bugsList)].filter(Boolean).slice(0, 3);
    return fallback.map((l, i) => ({ ...l, reason: i === 0 ? 'General bug tracker' : 'Available list' }));
  }
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
  const bugId = storeBug(bug);
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('View Existing Ticket').setStyle(ButtonStyle.Link).setURL(result.matchedTask.url).setEmoji('🔗'),
    new ButtonBuilder().setCustomId(`create_anyway:${bugId}`).setLabel('Create Anyway').setStyle(ButtonStyle.Secondary).setEmoji('🆕'),
  )];
}

async function buildListPickerEmbed(bug, result, user) {
  const priorityEmoji = { urgent: '🔴', high: '🟠', normal: '🟡', low: '🟢' }[bug.priority] ?? '⚪';
  const [suggestions, allLists] = await Promise.all([suggestLists(bug), getWorkspaceLists()]);
  const bugId = storeBug(bug);

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('📋 Where should this bug go?')
    .setFooter({ text: 'Only visible to you' })
    .setTimestamp();

  if (suggestions.length > 0) {
    embed.setDescription(`No duplicate found for **${bug.title}**\nPick a list to file it in:`);
    embed.addFields(suggestions.map((s, i) => ({
      name:  `${['1️⃣','2️⃣','3️⃣'][i]} ${s.name}`,
      value: `*${s.folder}* · ${s.reason}`,
      inline: false,
    })));
  } else {
    embed.setDescription(`No duplicate found for **${bug.title}**\nCouldn't load suggested lists — use **Other list…** to browse all options.`);
  }

  const buttons = suggestions.map((s, i) =>
    new ButtonBuilder()
      .setCustomId(`create_in:${s.id}:${bugId}`)
      .setLabel(s.name.length > 25 ? s.name.slice(0, 23) + '…' : s.name)
      .setStyle([ButtonStyle.Primary, ButtonStyle.Secondary, ButtonStyle.Secondary][i])
      .setEmoji(['1️⃣','2️⃣','3️⃣'][i])
  );

  const browseId = storeBug({ bug, page: 0 });
  buttons.push(
    new ButtonBuilder()
      .setCustomId(`browse_lists:${browseId}`)
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

module.exports = {
  register,
  handle,
  handleBugReaction,
  refreshListCache: () => getWorkspaceLists(true),
};