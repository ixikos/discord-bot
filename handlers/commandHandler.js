const { REST, Routes, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, EmbedBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const messageHandler = require('./messageHandler');
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ---------------------------------------------------------------------------
// Pending image upload store — maps a user+channel key to a ClickUp task ID.
// When the bot asks a user to upload images, it watches for their next message.
// ---------------------------------------------------------------------------
const _pendingImages = new Map();
const PENDING_TTL_MS = 5 * 60 * 1000; // 5 minutes

function setPendingImage(userId, channelId, taskId) {
  _pendingImages.set(`${userId}:${channelId}`, { taskId, expires: Date.now() + PENDING_TTL_MS });
}

function getPendingImage(userId, channelId) {
  const key = `${userId}:${channelId}`;
  const entry = _pendingImages.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) { _pendingImages.delete(key); return null; }
  return entry.taskId;
}

function clearPendingImage(userId, channelId) {
  _pendingImages.delete(`${userId}:${channelId}`);
}

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

async function clickupUpdateTask(taskId, { extraDescription, steps, severity }) {
  const priorityMap = { urgent: 1, high: 2, normal: 3, low: 4 };
  const body = {};
  const parts = [];
  if (extraDescription) parts.push(extraDescription);
  if (steps) parts.push(`\n\nAdditional Steps:\n${steps}`);
  if (parts.length) body.description = parts.join('');
  if (severity && priorityMap[severity]) body.priority = priorityMap[severity];

  const res = await fetch(`${CLICKUP_API}/task/${taskId}`, {
    method:  'PUT',
    headers: { Authorization: clickupAuthHeader(), 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`ClickUp update failed ${res.status}: ${err}`);
  }
}

async function clickupAttachImage(taskId, imageUrl, filename) {
  // Fetch the image from Discord CDN
  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) throw new Error(`Failed to fetch image: ${imgRes.status}`);
  const buffer = Buffer.from(await imgRes.arrayBuffer());

  // Build multipart/form-data manually using FormData (Node 18+ built-in)
  const { FormData, Blob } = globalThis;
  const form = new FormData();
  form.append('attachment', new Blob([buffer]), filename);
  form.append('filename', filename);

  const res = await fetch(`${CLICKUP_API}/task/${taskId}/attachment`, {
    method:  'POST',
    headers: { Authorization: clickupAuthHeader() },
    body:    form,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`ClickUp attachment failed ${res.status}: ${err}`);
  }
  return await res.json();
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
          return interaction.reply({ content: 'No pending bugs queued.', flags: MessageFlags.Ephemeral });
        }
        const lines = bugs.map((b, i) =>
          `**${i + 1}.** <@${b.author}> at ${new Date(b.timestamp).toLocaleTimeString()}: ${b.content.slice(0, 100)}`
        );
        return interaction.reply({
          content: `**${bugs.length} pending bug(s):**\n${lines.join('\n')}`,
          flags: MessageFlags.Ephemeral,
        });
      }

      case 'flush-bugs': {
        // Only admins
        if (!interaction.member.permissions.has('Administrator')) {
          return interaction.reply({ content: 'Admin only.', flags: MessageFlags.Ephemeral });
        }
        const bugs = messageHandler.loadBugs();
        if (bugs.length === 0) {
          return interaction.reply({ content: 'No bugs to flush.', flags: MessageFlags.Ephemeral });
        }
        // Forward to n8n for processing
        await forwardBugsToN8n(bugs);
        messageHandler.clearBugs();
        return interaction.reply({ content: `✅ Sent ${bugs.length} bug(s) to n8n for processing.` });
      }

      case 'refresh-lists': {
        if (!interaction.member.permissions.has('Administrator')) {
          return interaction.reply({ content: 'Admin only.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
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
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

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

  // "Add Details" modal submission — update the ClickUp ticket
  if (interaction.isModalSubmit() && interaction.customId.startsWith('detail_modal:')) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const taskRef = interaction.customId.split('detail_modal:')[1];
    const stored = retrieveBug(taskRef);
    if (!stored) return interaction.editReply('❌ Session expired — ticket may still exist, check ClickUp directly.');

    const { taskId } = stored;
    const extraDescription = interaction.fields.getTextInputValue('extra_description');
    const steps            = interaction.fields.getTextInputValue('steps');
    const severity         = interaction.fields.getTextInputValue('severity') || null;

    if (!extraDescription && !steps && !severity) {
      return interaction.editReply('Nothing to update — all fields were empty.');
    }

    try {
      await clickupUpdateTask(taskId, { extraDescription, steps, severity });
      await interaction.editReply(`✅ Ticket updated! [View in ClickUp](https://app.clickup.com/t/${taskId})`);
    } catch (err) {
      await interaction.editReply(`❌ Failed to update ticket: ${err.message}`);
    }
  }

  // Modal from build bug button
  if (interaction.isModalSubmit() && interaction.customId.startsWith('bug_modal_build:')) {
    const [, buildId, version] = interaction.customId.split(':');
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

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
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
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
      const taskId = url.split('/t/')[1];

      // Auto-upload any images that came with the original message
      let imageNote = '';
      if (bug.images?.length > 0) {
        const uploads = await Promise.allSettled(
          bug.images.map(img => clickupAttachImage(taskId, img.url, img.name))
        );
        const ok   = uploads.filter(r => r.status === 'fulfilled').length;
        const fail = uploads.filter(r => r.status === 'rejected').length;
        imageNote = ok > 0 ? `\n📎 ${ok} image${ok !== 1 ? 's' : ''} attached automatically` : '';
        if (fail > 0) imageNote += ` (${fail} failed)`;
      }

      const taskRef = storeBug({ taskId, bug });
      const createdResult = { isDuplicate: false, matchedTask: null, createdTask: { url }, summary: `Ticket created in **${list?.name ?? listId}**.` };
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x57F287)
            .setTitle('✅ Bug Ticket Created')
            .setDescription(`Filed in **${list?.name ?? listId}** (${list?.folder ?? ''})${imageNote}`)
            .addFields({ name: bug.title, value: `[View Ticket](${url})` })
            .setTimestamp(),
        ],
        components: [buildTicketActionsRow(taskRef)],
      });
      await postPublicResult(bug, createdResult, interaction.user, client);
    } catch (err) {
      await interaction.editReply({ content: `❌ Failed to create ticket: ${err.message}`, components: [] });
    }
  }

  // "Add Details" button — open modal to add extra info to the ticket
  if (interaction.isButton() && interaction.customId.startsWith('add_details:')) {
    const taskRef = interaction.customId.split('add_details:')[1];
    const stored  = retrieveBug(taskRef);
    const bug     = stored?.bug ?? null;

    // Truncate to Discord's 4000 char max for placeholder, 1024 for setValue
    const descPlaceholder  = bug?.description ? bug.description.slice(0, 990) + (bug.description.length > 990 ? '…' : '') : 'Any extra context, environment details, frequency...';
    const stepsPlaceholder = bug?.steps        ? bug.steps.slice(0, 990)                                                   : '1. Open inventory\n2. Move item\n3. Observe blank slot';
    const currentPriority  = bug?.priority     ? bug.priority                                                              : 'normal';

    const modal = new ModalBuilder()
      .setCustomId(`detail_modal:${taskRef}`)
      .setTitle('Edit / Add Details');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('extra_description')
          .setLabel('Description (edit or append)')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setPlaceholder(descPlaceholder)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('steps')
          .setLabel('Steps to Reproduce')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setPlaceholder(stepsPlaceholder)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('severity')
          .setLabel('Severity (low / normal / high / urgent)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setValue(currentPriority)
      ),
    );
    return interaction.showModal(modal);
  }

  // "Add Images" button — prompt user to reply with screenshots
  if (interaction.isButton() && interaction.customId.startsWith('add_images:')) {
    const taskRef = interaction.customId.split('add_images:')[1];
    const stored = retrieveBug(taskRef);
    if (!stored) return interaction.reply({ content: '❌ Session expired.', flags: MessageFlags.Ephemeral });
    const { taskId } = stored;

    // Register this user+channel as waiting for images
    setPendingImage(interaction.user.id, interaction.channelId, taskId);

    await interaction.reply({
      content: `📎 <@${interaction.user.id}> Upload your screenshots by replying to this message with images attached. I'll add them to the ticket automatically. *(You have 5 minutes)*`,
    });
  }

  // "Other list…" — show paginated full list browser
  if (interaction.isButton() && interaction.customId.startsWith('browse_lists:')) {
    // Use deferReply if this is a fresh interaction (from create_anyway),
    // otherwise update in place (already has an ephemeral reply)
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } else {
      await interaction.deferUpdate();
    }
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
// Step 1: Fetch all tasks from relevant lists, then let Claude do fuzzy matching
// ---------------------------------------------------------------------------

// Lists to search for duplicates — active sprint + bugs epic
const SEARCH_LIST_IDS = (process.env.CLICKUP_SEARCH_LISTS || '901113636505,901113636608').split(',');

async function fetchAllTasksForSearch() {
  const allTasks = [];
  for (const listId of SEARCH_LIST_IDS) {
    let page = 0;
    while (true) {
      const res = await fetch(
        `${CLICKUP_API}/list/${listId}/task?archived=false&subtasks=true&page=${page}`,
        { headers: { Authorization: clickupAuthHeader() } }
      );
      if (!res.ok) {
        console.warn(`Failed to fetch tasks from list ${listId}: ${res.status}`);
        break;
      }
      const data = await res.json();
      const tasks = data.tasks || [];
      allTasks.push(...tasks.map(t => ({
        id:     t.id,
        name:   t.name,
        status: t.status?.status ?? 'unknown',
        url:    `https://app.clickup.com/t/${t.id}`,
        list:   t.list?.name ?? listId,
      })));
      // ClickUp paginates at 100 tasks/page; stop if we got fewer than 100
      if (tasks.length < 100) break;
      page++;
    }
  }
  return allTasks;
}

async function checkDuplicate(bug) {
  const tasks = await fetchAllTasksForSearch();

  if (tasks.length === 0) {
    console.warn('No tasks fetched for duplicate check — check CLICKUP_API_KEY and list IDs');
    return { isDuplicate: false, confidence: 'low', matchedTask: null, summary: 'Could not fetch tasks for comparison.' };
  }

  const taskList = tasks.map(t => `- [${t.id}] (${t.status}) ${t.name}`).join('\n');

  const response = await anthropic.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 600,
    system: `You are a bug-triage assistant for a game called Skydew Islands.
You will be given a new bug report and a full list of existing tasks.
Use semantic reasoning to decide if any existing task is a genuine duplicate — even if the wording is different.
Respond ONLY with JSON — no prose, no markdown fences:
{
  "isDuplicate": true | false,
  "confidence": "high" | "medium" | "low",
  "matchedTaskId": "id or null",
  "matchedTaskName": "name or null",
  "matchedTaskUrl": "https://app.clickup.com/t/{id} or null",
  "matchedTaskStatus": "status or null",
  "similarity": "one sentence why it matches, or null",
  "summary": "2-3 sentence explanation"
}
isDuplicate=true only for medium or high confidence genuine matches — not just same general topic.`,
    messages: [{ role: 'user', content:
      `New bug report:\nTitle: ${bug.title}\nDescription: ${bug.description}${bug.steps ? '\nSteps: ' + bug.steps : ''}\n\nExisting tasks (${tasks.length} total):\n${taskList}\n\nIs any existing task a genuine duplicate of this bug?`
    }],
  });

  const rawText = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
  try {
    const a = JSON.parse(rawText.replace(/```json|```/g, '').trim());
    // Build URL from id if not provided
    if (a.matchedTaskId && !a.matchedTaskUrl) {
      a.matchedTaskUrl = `https://app.clickup.com/t/${a.matchedTaskId}`;
    }
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
  // Store a taskRef pointing at the existing matched ticket so Add Details/Images can attach to it
  const taskRef = storeBug({ taskId: result.matchedTask.id, bug });
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('View Ticket').setStyle(ButtonStyle.Link).setURL(result.matchedTask.url).setEmoji('🔗'),
    new ButtonBuilder().setCustomId(`create_anyway:${bugId}`).setLabel('Create Anyway').setStyle(ButtonStyle.Secondary).setEmoji('🆕'),
    new ButtonBuilder().setCustomId(`add_details:${taskRef}`).setLabel('Add Details').setStyle(ButtonStyle.Secondary).setEmoji('📝'),
    new ButtonBuilder().setCustomId(`add_images:${taskRef}`).setLabel('Add Images').setStyle(ButtonStyle.Secondary).setEmoji('🖼️'),
  )];
}

function buildTicketActionsRow(taskRef) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`add_details:${taskRef}`)
      .setLabel('Add Details')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('📝'),
    new ButtonBuilder()
      .setCustomId(`add_images:${taskRef}`)
      .setLabel('Add Images')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('🖼️'),
  );
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
  // Allow image-only messages or short captions if there are attachments
  const hasImages = message.attachments.size > 0;
  const hasText   = message.content && message.content.trim().length >= 10;
  if (!hasText && !hasImages) {
    await message.reply(`<@${user.id}> ⚠️ That message doesn't have enough content to file a bug from. Try the \`/bug\` command instead.`);
    return;
  }

  // Prevent duplicate processing — check if bot already reacted with ✅ or 🔄
  for (const reactionName of ['✅', '🔄']) {
    const existing = message.reactions.cache.get(reactionName);
    if (existing) {
      const users = await existing.users.fetch().catch(() => null);
      if (users?.has(client.user.id)) return;
    }
  }

  // Acknowledge immediately so user knows it's working
  await message.react('🔄').catch(() => {});

  // Collect any images attached to the original message
  const messageImages = [...message.attachments.values()]
    .filter(a => a.contentType?.startsWith('image/') || /\.(png|jpg|jpeg|gif|webp)$/i.test(a.name ?? ''))
    .map(a => ({ url: a.url, name: a.name ?? 'screenshot.png' }));

  const bug = {
    title:       inferTitle(message.content),
    description: message.content,
    steps:       null,
    priority:    'normal',
    author:      message.author.username,
    timestamp:   message.createdAt.toISOString(),
    sourceUrl:   message.url,
    images:      messageImages,
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
  if (!content || content.trim().length < 3) return 'Bug report (see images)';
  const firstSentence = content.split(/[.!?\n]/)[0].trim();
  if (firstSentence.length >= 10 && firstSentence.length <= 100) return firstSentence;
  return content.slice(0, 80).trim() + (content.length > 80 ? '…' : '');
}

// ---------------------------------------------------------------------------
// Image upload handler — called from messageCreate when a pending upload exists
// ---------------------------------------------------------------------------
async function handleImageUpload(message, client) {
  if (message.author.bot) return;
  if (message.attachments.size === 0) return;

  const taskId = getPendingImage(message.author.id, message.channelId);
  if (!taskId) return;

  // Clear pending so we don't process follow-up messages
  clearPendingImage(message.author.id, message.channelId);

  const images = [...message.attachments.values()].filter(a =>
    a.contentType?.startsWith('image/') || /\.(png|jpg|jpeg|gif|webp)$/i.test(a.name)
  );

  if (images.length === 0) {
    await message.reply('⚠️ No image attachments found. Please upload PNG, JPG, or GIF files.');
    return;
  }

  await message.react('🔄').catch(() => {});

  const results = await Promise.allSettled(
    images.map(img => clickupAttachImage(taskId, img.url, img.name))
  );

  const succeeded = results.filter(r => r.status === 'fulfilled').length;
  const failed    = results.filter(r => r.status === 'rejected').length;

  await message.reactions.cache.get('🔄')?.remove().catch(() => {});
  await message.react('✅').catch(() => {});

  const summary = failed > 0
    ? `✅ ${succeeded} image${succeeded !== 1 ? 's' : ''} uploaded, ❌ ${failed} failed.`
    : `✅ ${succeeded} image${succeeded !== 1 ? 's' : ''} added to the ticket!`;

  await message.reply(`${summary} [View ticket](https://app.clickup.com/t/${taskId})`);
}

module.exports = {
  register,
  handle,
  handleBugReaction,
  handleImageUpload,
  refreshListCache: () => getWorkspaceLists(true),
};