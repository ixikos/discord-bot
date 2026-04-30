require('dotenv').config();
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err);
});

console.log('TOKEN EXISTS:', !!process.env.DISCORD_TOKEN);

const { Client, GatewayIntentBits, Partials } = require('discord.js');
const express = require('express');

// Express starts FIRST so Railway sees the port immediately
const app = express();
app.get('/health', (req, res) => res.json({ ok: true }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Webhook server listening on :${PORT}`));

// Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

// Load handlers
const commandHandler = require('./handlers/commandHandler');
const webhookHandler = require('./handlers/webhookHandler');
const messageHandler = require('./handlers/messageHandler');

// Webhook route (needs client, so registered after client is defined)
app.post('/webhook/:type', async (req, res) => {
  const { type } = req.params;
  const secret = req.headers['x-webhook-secret'];
  if (secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    await webhookHandler.handle(type, req.body, client);
    res.json({ ok: true });
  } catch (err) {
    console.error(`Webhook error [${type}]:`, err);
    res.status(500).json({ error: err.message });
  }
});

client.once('ready', async () => {
  console.log(`✅ Bot online as ${client.user.tag}`);
  await commandHandler.register(client);
  // Pre-warm the ClickUp list cache so first /bug is fast
  await commandHandler.refreshListCache().catch(err =>
    console.error('Failed to pre-warm ClickUp list cache:', err.message)
  );
});

client.on('interactionCreate', async (interaction) => {
  await commandHandler.handle(interaction, client);
});

client.on('messageCreate', async (message) => {
  console.log(`Message received in channel: ${message.channelId} | BUGS_CHANNEL_ID: ${process.env.BUGS_CHANNEL_ID}`);
  // Watch for pending image uploads — user replying with screenshots
  await commandHandler.handleImageUpload(message, client);
  await messageHandler.handle(message, client);
});

client.on('messageReactionAdd', async (reaction, user) => {
  // Log every reaction so we can see exactly what Discord sends
  console.log(`[reaction] user=${user.tag} bot=${user.bot} emoji.name=${reaction.emoji.name} emoji.id=${reaction.emoji.id} emoji.toString=${reaction.emoji.toString()}`);

  if (user.bot) return;

  // Match both the unicode character and the name string Discord might send
  const isBugEmoji = reaction.emoji.name === '\u{1F41B}'
    || reaction.emoji.name === '🐛'
    || reaction.emoji.name === 'bug';

  if (!isBugEmoji) return;

  console.log(`[reaction] 🐛 detected from ${user.tag} on message ${reaction.message.id}`);

  try {
    if (reaction.partial) await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();
    await commandHandler.handleBugReaction(reaction.message, user, client);
  } catch (err) {
    console.error('messageReactionAdd error:', err);
  }
});

client.login(process.env.DISCORD_TOKEN);