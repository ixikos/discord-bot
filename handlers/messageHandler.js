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
  if (message.author.bot) return;
  if (message.channelId !== process.env.BUGS_CHANNEL_ID) return;

  // Auto-trigger the bug flow as if user reacted 🐛 to their own message
  const commandHandler = require('./commandHandler');
  await commandHandler.handleBugReaction(message, message.author, client);
}

module.exports = { handle, loadBugs, clearBugs };