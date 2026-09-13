/**
 * WestJet | PTFS - Apply Bot (version compacte)
 * -----------------------------------------------------
 * Panneau -> DM -> questions -> review staff (Accept/Deny).
 * Modération de base incluse + auto-blacklist si âge < 13.
 */

require('dotenv').config();
const fs = require('fs');
const http = require('http');
const {
  Client, GatewayIntentBits, Partials, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionsBitField,
} = require('discord.js');

const TOKEN = process.env.BOT_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const REVIEW_CHANNEL_ID = process.env.REVIEW_CHANNEL_ID;
const STAFF_ROLE_ID = process.env.STAFF_ROLE_ID;
const MIN_AGE = 13;
const TIMEOUT_MS = 3 * 60 * 60 * 1000;
const COLOR = 0x00885A;
const DENY = 0xC8102E;
const BLACKLIST_FILE = './blacklist.json';
const BAD_WORDS = ['nigger', 'nigga', 'faggot', 'retard', 'kys', 'cunt'];
const LAZY = new Set(['idk', 'na', 'n/a', 'none', 'lol', 'test', 'asdf', 'ok', 'sure']);

// ---- blacklist (fichier JSON simple) ----
const loadBL = () => (fs.existsSync(BLACKLIST_FILE) ? JSON.parse(fs.readFileSync(BLACKLIST_FILE)) : {});
const saveBL = (d) => fs.writeFileSync(BLACKLIST_FILE, JSON.stringify(d, null, 2));
const isBL = (id) => Boolean(loadBL()[id]);
const addBL = (id, tag, reason) => { const bl = loadBL(); bl[id] = { tag, reason, date: new Date().toISOString() }; saveBL(bl); };
const removeBL = (id) => { const bl = loadBL(); const ok = Boolean(bl[id]); delete bl[id]; saveBL(bl); return ok; };

// ---- modération : renvoie null si ok, sinon un message d'erreur ----
function moderate(text, q) {
  const t = text.trim();
  if (q.type === 'scale') {
    const n = Number(t);
    return Number.isInteger(n) && n >= 1 && n <= 10 ? null : 'Réponds avec un nombre entier entre 1 et 10.';
  }
  if (BAD_WORDS.some((w) => t.toLowerCase().includes(w))) return 'Ce langage n\'est pas autorisé ici.';
  if (t.length < (q.min || 8)) return `Réponds avec un peu plus de détails (min. ${q.min || 8} caractères).`;
  if (LAZY.has(t.toLowerCase())) return 'Merci de donner une vraie réponse, pas juste un mot.';
  return null;
}

// ---- questions ----
const COMMON = [
  { key: 'username', text: 'Ton pseudo Roblox ?', min: 3 },
  { key: 'age', text: 'Quel âge as-tu ?', type: 'age' },
  { key: 'activity', text: 'Sur 10, ton activité sur PTFS ?', type: 'scale' },
  { key: 'motivation', text: 'Pourquoi veux-tu rejoindre WestJet ?', min: 12 },
];

const DEPARTMENTS = {
  atc: { label: '🛫 Air Traffic Control', color: COLOR, questions: [
    { key: 'atc_exp', text: 'As-tu déjà fait de l\'ATC (ProController, VATSIM...) ?', min: 5 },
    { key: 'atc_scenario', text: 'Deux avions demandent la même piste en même temps. Tu fais quoi ?', min: 12 },
  ]},
  mod: { label: '🛡️ Moderator', color: 0xF2A900, questions: [
    { key: 'mod_exp', text: 'As-tu déjà modéré un serveur Discord ? Raconte.', min: 12 },
    { key: 'mod_scenario', text: 'Un membre spam et insulte les autres. Tes étapes ?', min: 12 },
  ]},
  cabin: { label: '🧳 Cabin Crew', color: 0x4EA5D9, questions: [
    { key: 'cabin_exp', text: 'As-tu déjà été cabin crew ici ou ailleurs ?', min: 5 },
    { key: 'cabin_scenario', text: 'Un passager est furieux à cause de son repas. Tu réagis comment ?', min: 12 },
  ]},
  pilot: { label: '✈️ Pilot', color: 0x6C4AB6, questions: [
    { key: 'pilot_rank', text: 'Ton rang PTFS actuel et tes heures de vol ?', min: 3 },
    { key: 'pilot_scenario', text: 'Tu perds un moteur juste après le décollage. Ton plan ?', min: 12 },
  ]},
};
const questionsFor = (dept) => [...COMMON, ...DEPARTMENTS[dept].questions];

// ---- sessions en mémoire ----
const sessions = new Map();
const clearSession = (id) => { clearTimeout(sessions.get(id)?.timeout); sessions.delete(id); };

// ---- client ----
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel, Partials.Message],
});
client.once('ready', () => console.log(`Connecté en tant que ${client.user.tag}`));

const isStaff = (m) => m?.permissions.has(PermissionsBitField.Flags.Administrator) || (STAFF_ROLE_ID && m?.roles.cache.has(STAFF_ROLE_ID));

function panelEmbed() {
  return new EmbedBuilder()
    .setTitle('✈️ Rejoins l\'équipe WestJet | PTFS')
    .setDescription('Choisis un poste ci-dessous. Tu répondras à quelques questions **en DM**.')
    .setColor(COLOR);
}
function panelRow() {
  return new ActionRowBuilder().addComponents(
    ...Object.entries(DEPARTMENTS).map(([key, d]) =>
      new ButtonBuilder().setCustomId(`apply_${key}`).setLabel(d.label).setStyle(ButtonStyle.Secondary))
  );
}
function questionEmbed(dept, step) {
  const list = questionsFor(dept);
  return new EmbedBuilder()
    .setTitle(DEPARTMENTS[dept].label)
    .setDescription(`**Question ${step + 1}/${list.length}**\n${list[step].text}`)
    .setColor(DEPARTMENTS[dept].color);
}
function cancelRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('cancel').setLabel('Annuler').setStyle(ButtonStyle.Danger)
  );
}
function summaryEmbed(dept, user, answers) {
  const e = new EmbedBuilder().setTitle(`Nouvelle candidature — ${DEPARTMENTS[dept].label}`)
    .setColor(DEPARTMENTS[dept].color).setThumbnail(user.displayAvatarURL()).setFooter({ text: `ID: ${user.id}` });
  for (const q of questionsFor(dept)) e.addFields({ name: q.text, value: String(answers[q.key] ?? 'N/A').slice(0, 1024) });
  return e;
}
function reviewRow(userId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`accept_${userId}`).setLabel('Accepter').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`deny_${userId}`).setLabel('Refuser').setStyle(ButtonStyle.Danger)
  );
}

async function sendNext(user) {
  const s = sessions.get(user.id);
  if (!s) return;
  const list = questionsFor(s.dept);
  if (s.step >= list.length) return finish(user);

  await user.send({ embeds: [questionEmbed(s.dept, s.step)], components: [cancelRow()] });
  clearTimeout(s.timeout);
  s.timeout = setTimeout(() => {
    sessions.delete(user.id);
    user.send('⏰ Temps écoulé (3h). Relance une candidature si intéressé.').catch(() => {});
  }, TIMEOUT_MS);
}

async function finish(user) {
  const s = sessions.get(user.id);
  if (!s) return;
  if (REVIEW_CHANNEL_ID) {
    const ch = await client.channels.fetch(REVIEW_CHANNEL_ID).catch(() => null);
    if (ch) await ch.send({ embeds: [summaryEmbed(s.dept, user, s.answers)], components: [reviewRow(user.id)] });
  }
  await user.send('🎉 Candidature envoyée ! Le staff va l\'examiner.').catch(() => {});
  clearSession(user.id);
}

client.on('interactionCreate', async (i) => {
  if (!i.isButton()) return;
  const { customId: id, user } = i;

  if (id.startsWith('apply_')) {
    const dept = id.replace('apply_', '');
    if (isBL(user.id)) return i.reply({ content: '🚫 Tu es blacklisté.', ephemeral: true });
    if (sessions.has(user.id)) return i.reply({ content: '📨 Candidature déjà en cours, check tes DMs.', ephemeral: true });
    try {
      await user.send({ embeds: [new EmbedBuilder().setTitle(DEPARTMENTS[dept].label).setDescription('Prêt à commencer ? 3h pour tout compléter.').setColor(DEPARTMENTS[dept].color)],
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`start_${dept}`).setLabel('Commencer').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('cancel_confirm').setLabel('Annuler').setStyle(ButtonStyle.Danger))] });
      await i.reply({ content: '✅ Check tes DMs !', ephemeral: true });
    } catch { await i.reply({ content: '❌ Active tes DMs et réessaie.', ephemeral: true }); }
    return;
  }

  if (id.startsWith('start_')) {
    const dept = id.replace('start_', '');
    sessions.set(user.id, { dept, step: 0, answers: {}, timeout: null });
    await i.update({ content: '🚀 C\'est parti !', embeds: [], components: [] });
    return sendNext(user);
  }

  if (id === 'cancel_confirm') return i.update({ content: 'Annulé.', embeds: [], components: [] });
  if (id === 'cancel') { clearSession(user.id); return i.update({ content: 'Candidature annulée.', embeds: [], components: [] }); }

  if (id.startsWith('accept_') || id.startsWith('deny_')) {
    if (!isStaff(i.member)) return i.reply({ content: '🚫 Réservé au staff.', ephemeral: true });
    const applicantId = id.split('_')[1];
    const accepted = id.startsWith('accept_');
    const embed = EmbedBuilder.from(i.message.embeds[0]).setColor(accepted ? COLOR : DENY)
      .setFooter({ text: `${accepted ? 'Accepté' : 'Refusé'} par ${i.user.tag}` });
    await i.update({ embeds: [embed], components: [] });
    const applicant = await client.users.fetch(applicantId).catch(() => null);
    if (applicant) applicant.send(accepted ? '🎉 Candidature acceptée !' : 'Candidature refusée, tu peux retenter plus tard.').catch(() => {});
  }
});

client.on('messageCreate', async (msg) => {
  if (msg.author.bot || msg.guild) return; // DM only
  const s = sessions.get(msg.author.id);
  if (!s) return;

  const list = questionsFor(s.dept);
  const q = list[s.step];

  if (q.type === 'age') {
    const age = parseInt(msg.content.match(/\d+/)?.[0], 10);
    if (isNaN(age) || age < MIN_AGE) {
      clearSession(msg.author.id);
      addBL(msg.author.id, msg.author.tag, `Âge < ${MIN_AGE}`);
      const guild = client.guilds.cache.get(GUILD_ID);
      const member = await guild?.members.fetch(msg.author.id).catch(() => null);
      if (member?.kickable) await member.kick('Auto-blacklist: âge insuffisant').catch(() => {});
      return msg.author.send('Tu ne remplis pas l\'âge minimum (13+). Candidature annulée et blacklisté.').catch(() => {});
    }
    s.answers[q.key] = String(age);
  } else {
    const error = moderate(msg.content, q);
    if (error) return msg.author.send(`⚠️ ${error}\n\n${q.text}`).catch(() => {});
    s.answers[q.key] = msg.content.trim();
  }

  s.step += 1;
  sendNext(msg.author);
});

client.login(TOKEN);

// serveur HTTP factice pour Render
http.createServer((req, res) => { res.writeHead(200); res.end('OK'); }).listen(process.env.PORT || 3000);
