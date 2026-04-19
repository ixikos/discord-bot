const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

/**
 * Add a new webhook type here and it will be handled automatically.
 * Each handler receives (payload, client) and returns void.
 */
const handlers = {

  // POST /webhook/build
  // Expected payload: { status, version, platform, duration, downloadUrl, logsUrl, buildId }
  build: async (payload, client) => {
    const channel = await getChannel(client, process.env.BUILDS_CHANNEL_ID);
    if (!channel) return;

    const success = payload.status === 'success';

    const embed = new EmbedBuilder()
      .setColor(success ? 0x57F287 : 0xED4245)
      .setTitle(`${success ? '✅' : '❌'} Build ${success ? 'Complete' : 'Failed'} — ${payload.version}`)
      .addFields(
        { name: 'Platform',  value: payload.platform  || 'Unknown', inline: true },
        { name: 'Duration',  value: payload.duration  || 'Unknown', inline: true },
        { name: 'Build ID',  value: payload.buildId   || 'Unknown', inline: true },
      )
      .setTimestamp();

    if (payload.error) {
      embed.addFields({ name: 'Error', value: `\`\`\`${payload.error}\`\`\`` });
    }

    const row = new ActionRowBuilder();

    if (success && payload.downloadUrl) {
      row.addComponents(
        new ButtonBuilder()
          .setLabel('Download')
          .setStyle(ButtonStyle.Link)
          .setURL(payload.downloadUrl)
          .setEmoji('📦')
      );
    }

    if (payload.logsUrl) {
      row.addComponents(
        new ButtonBuilder()
          .setLabel('View Logs')
          .setStyle(ButtonStyle.Link)
          .setURL(payload.logsUrl)
          .setEmoji('📋')
      );
    }

    // "File Bug" button triggers a modal via interactionCreate
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`file_bug:${payload.buildId}:${payload.version}`)
        .setLabel('File Bug')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('🐛')
    );

    await channel.send({
      embeds: [embed],
      components: row.components.length > 0 ? [row] : [],
    });
  },

  // POST /webhook/n8n
  // Generic passthrough — n8n sends a pre-formatted message to any channel
  // Expected payload: { channelId, message, embeds? }
  n8n: async (payload, client) => {
    const channel = await getChannel(client, payload.channelId);
    if (!channel) return;

    await channel.send({
      content: payload.message || undefined,
      embeds:  payload.embeds  || [],
    });
  },

  // POST /webhook/tickets-created
  // n8n calls this after EOD batch to post a summary of created ClickUp tickets
  // Expected payload: { tickets: [{ title, url, priority }] }
  'tickets-created': async (payload, client) => {
    const channel = await getChannel(client, process.env.BUGS_CHANNEL_ID);
    if (!channel) return;

    if (!payload.tickets || payload.tickets.length === 0) {
      await channel.send('📋 EOD sweep complete — no new bugs found.');
      return;
    }

    const lines = payload.tickets.map(t => {
      const priority = t.priority ? `[${t.priority}] ` : '';
      return `• ${priority}[${t.title}](${t.url})`;
    });

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle(`📋 ${payload.tickets.length} ticket${payload.tickets.length > 1 ? 's' : ''} created from today's bugs`)
      .setDescription(lines.join('\n'))
      .setTimestamp();

    await channel.send({ embeds: [embed] });
  },
};

async function handle(type, payload, client) {
  const handler = handlers[type];
  if (!handler) {
    throw new Error(`Unknown webhook type: "${type}". Add it to webhookHandler.js.`);
  }
  await handler(payload, client);
}

async function getChannel(client, channelId) {
  if (!channelId) {
    console.warn('getChannel called with no channelId');
    return null;
  }
  try {
    return await client.channels.fetch(channelId);
  } catch (err) {
    console.error(`Could not fetch channel ${channelId}:`, err.message);
    return null;
  }
}

module.exports = { handle };
