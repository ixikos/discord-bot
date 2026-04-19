console.log('TOKEN EXISTS:', !!process.env.DISCORD_TOKEN);

require('dotenv').config();
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const express = require('express');

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
const commandHandler  = require('./handlers/commandHandler');
const webhookHandler  = require('./handlers/webhookHandler');
const messageHandler  = require('./handlers/messageHandler');

// Register slash commands on startup
client.once('ready', async () => {
  console.log(`✅ Bot online as ${client.user.tag}`);
  await commandHandler.register(client);
});

// Slash command interactions
client.on('interactionCreate', async (interaction) => {
  await commandHandler.handle(interaction, client);
});

// Message events (bug channel monitoring)
client.on('messageCreate', async (message) => {
  console.log(`Message received in channel: ${message.channelId} | BUGS_CHANNEL_ID: ${process.env.BUGS_CHANNEL_ID}`);
  await messageHandler.handle(message, client);
});

client.login(process.env.DISCORD_TOKEN);

// Express server — receives webhooks from build machine / n8n
const app = express();
app.use(express.json());

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Webhook server listening on :${PORT}`));
