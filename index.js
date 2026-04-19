require('dotenv').config();
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
});

client.on('interactionCreate', async (interaction) => {
  await commandHandler.handle(interaction, client);
});

client.on('messageCreate', async (message) => {
  console.log(`Message received in channel: ${message.channelId} | BUGS_CHANNEL_ID: ${process.env.BUGS_CHANNEL_ID}`);
  await messageHandler.handle(message, client);
});

client.login(process.env.DISCORD_TOKEN);