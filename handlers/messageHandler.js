const fs   = require('fs');
const path = require('path');

const BUG_LOG_PATH = path.join(__dirname, '../data/pending-bugs.json');

// Ensure data dir exists
fs.mkdirSync(path.dirname(BUG_LOG_PATH), { recursive: true });

function loadBugs() {
  try {
    return JSON.parse(fs.readFileSync(BUG_LOG_PATH, 'utf8'));
  } catch {
    return [];
  }
}

function saveBugs(bugs) {
  fs.writeFileSync(BUG_LOG_PATH, JSON.stringify(bugs, null, 2));
}

function clearBugs() {
  saveBugs([]);
}

async function handle(message, client) {
  // Ignore bots
  if (message.author.bot) return;

  // Only watch the bugs channel
  if (message.channelId !== process.env.BUGS_CHANNEL_ID) return;

  // Store the message for EOD n8n batch processing
  const bugs = loadBugs();
  bugs.push({
    id:        message.id,
    author:    message.author.username,
    content:   message.content,
    timestamp: message.createdAt.toISOString(),
    attachments: message.attachments.map(a => a.url),
  });
  saveBugs(bugs);

  // React to acknowledge
  await message.react('👀').catch(() => {});
}

module.exports = { handle, loadBugs, clearBugs };
