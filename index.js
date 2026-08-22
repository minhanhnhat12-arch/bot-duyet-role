const express = require('express');
const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits
} = require('discord.js');

const app = express();
app.use(express.json());

let cachedGuild = null;

app.get('/', (req, res) => {
  res.status(200).send('Server Bot Discord đang hoạt động!');
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages
  ]
});

function parseRoleIds(rawValue) {
  return String(rawValue || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

async function getGuild() {
  if (cachedGuild) return cachedGuild;
  
  if (!process.env.GUILD_ID) {
    throw new Error('GUILD_ID chưa được cấu hình');
  }

  const guild = await client.guilds.fetch(process.env.GUILD_ID).catch(() => null);
  if (guild) cachedGuild = guild;
  return guild;
}

async function updateButtonState(interaction, label, style) {
  const disabledRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('done')
      .setLabel(label)
      .setStyle(style)
      .setDisabled(true)
  );

  await interaction.editReply({ components: [disabledRow] });
}

client.once('ready', () => {
  console.log(`✅ Bot đã đăng nhập thành công: ${client.user.tag}`);
  cachedGuild = client.guilds.cache.get(process.env.GUILD_ID);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  const parts = interaction.customId.split('_');
  if (parts.length < 2) return;

  const [action, discordUserId, targetRoleId] = parts;
  if (!discordUserId) return;

  try {
    await interaction.deferUpdate();

    const guild = await getGuild();
    if (!guild) {
      return interaction.followUp({ content: '❌ Không tìm thấy Server Discord!', ephemeral: true });
    }

    const member = await guild.members.fetch(discordUserId).catch(() => null);
    if (!member) {
      return interaction.followUp({ content: '❌ Không tìm thấy thành viên trong server!', ephemeral: true });
    }

    if (action === 'approve') {
      const botMember = await guild.members.fetchMe();
      if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
        return interaction.followUp({ content: '❌ Bot thiếu quyền Manage Roles!', ephemeral: true });
      }

      let rolesToAdd = new Set();

      // 1. Quét các ID Role (Quốc gia, BR, v.v.) được gửi qua từ Form
      if (targetRoleId) {
        const rawRoleIds = targetRoleId.split('-');
        for (const rId of rawRoleIds) {
          if (/^\d{17,19}$/.test(rId)) rolesToAdd.add(rId);
        }
      }

      // 2. Vẫn luôn giữ role dự phòng/mặc định (Nếu có cấu hình trong .env)
      const defaultRoles = parseRoleIds(process.env.ROLE_APPROVED_ID);
      for (const defaultId of defaultRoles) {
        rolesToAdd.add(defaultId);
      }

      const finalRoleIds = Array.from(rolesToAdd).filter(id => guild.roles.cache.has(id));

      if (finalRoleIds.length === 0) {
        return interaction.followUp({ content: '❌ Không tìm thấy ID Role hợp lệ để cấp!', ephemeral: true });
      }

      await member.roles.add(finalRoleIds);

      await updateButtonState(
        interaction,
        `Đã duyệt bởi ${interaction.user.username}`,
        ButtonStyle.Success
      );

      const formattedRoles = finalRoleIds.map(id => `<@&${id}>`).join(', ');
      await interaction.followUp({ content: `✅ Đã cấp các Role: ${formattedRoles} cho <@${discordUserId}>!`, ephemeral: true });
      return;
    }

    if (action === 'reject') {
      const rejectedRoleIds = parseRoleIds(process.env.ROLE_REJECTED_ID);
      if (rejectedRoleIds.length > 0) await member.roles.add(rejectedRoleIds);

      await updateButtonState(interaction, `Đã từ chối bởi ${interaction.user.username}`, ButtonStyle.Danger);
      await interaction.followUp({ content: `❌ Đã từ chối đơn của <@${discordUserId}>.`, ephemeral: true });
      return;
    }
  } catch (error) {
    console.error('❌ Lỗi:', error);
    await interaction.followUp({ content: '❌ Có lỗi xảy ra hoặc Role Bot nằm dưới Role cần cấp!', ephemeral: true }).catch(() => {});
  }
});

app.post('/submit-form', async (req, res) => {
  try {
    const { secret, username, discordUserId, answers = [] } = req.body || {};

    if (secret !== process.env.WEBHOOK_SECRET) return res.status(403).json({ error: 'Unauthorized' });

    const guild = await getGuild();
    if (!guild) return res.status(500).json({ error: 'Không tìm thấy Guild' });

    let finalUserId = discordUserId;
    if (!finalUserId || !/^\d{17,19}$/.test(finalUserId)) {
      const cleanInput = String(username || '').toLowerCase().replace('@', '').trim();
      try {
        const searchedMembers = await guild.members.search({ query: cleanInput, limit: 10 });
        const foundMember = searchedMembers.find(m => 
          m.user.username.toLowerCase() === cleanInput ||
          (m.user.globalName && m.user.globalName.toLowerCase() === cleanInput) ||
          (m.nickname && m.nickname.toLowerCase() === cleanInput)
        );
        if (foundMember) finalUserId = foundMember.id;
      } catch (err) {}
    }

    if (!finalUserId) return res.status(400).json({ error: 'Không tìm thấy Member!' });

    const channel = await client.channels.fetch(process.env.DISCORD_CHANNEL_ID).catch(() => null);
    if (!channel || !channel.isTextBased()) return res.status(500).json({ error: 'Channel không hợp lệ' });

    const guildRoles = await guild.roles.fetch().catch(() => null);
    let selectedRoleIds = new Set();

    if (guildRoles) {
      for (const item of answers) {
        const ans = String(item.answer || '').trim();
        if (!ans) continue;

        const answerParts = ans.split(/,|\n/).map(s => s.trim()).filter(Boolean);

        for (const part of answerParts) {
          // 1. Nếu form chứa thẳng ID Role
          const idMatches = part.match(/\d{17,19}/g);
          if (idMatches) {
            idMatches.forEach(id => {
              if (guildRoles.has(id)) selectedRoleIds.add(id);
            });
            continue; 
          }

          // 2. Tìm theo chữ (Đã sửa để bắt bén hơn)
          const cleanPart = part.toLowerCase();
          if (cleanPart.length > 1) { // Bỏ qua mấy chữ quá ngắn đỡ nhầm lẫn
            guildRoles.forEach(role => {
              if (!role.managed && role.name !== '@everyone') {
                const rName = role.name.toLowerCase().trim();
                // Nếu Tên Role chứa Chữ Điền (vd: 'mức br 5.7' chứa '5.7') hoặc ngược lại
                if (rName === cleanPart || rName.includes(cleanPart) || cleanPart.includes(rName)) {
                  selectedRoleIds.add(role.id);
                }
              }
            });
          }
        }
      }
    }

    // ⚠️ LƯU Ý QUAN TRỌNG: Discord giới hạn dữ liệu gắn lên Nút Bấm tối đa 100 ký tự. 
    // Do đó tui sẽ ghim TỐI ĐA 3 Role bóc từ Form lên nút (Dư sức cho Quốc Gia + BR + 1 role khác).
    const maxAllowedRoles = Array.from(selectedRoleIds).slice(0, 3);
    const roleString = maxAllowedRoles.join('-');
    const approveCustomId = roleString 
      ? `approve_${finalUserId}_${roleString}`
      : `approve_${finalUserId}`;

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(approveCustomId).setLabel('Duyệt').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`reject_${finalUserId}`).setLabel('Từ chối').setStyle(ButtonStyle.Danger)
    );

    const embed = new EmbedBuilder()
      .setTitle('📋 ĐƠN ĐĂNG KÝ MỚI')
      .setColor(0x3498db)
      .setTimestamp()
      .addFields({ name: 'Người gửi', value: username ? `${username} (<@${finalUserId}>)` : `<@${finalUserId}>` });

    answers.slice(0, 24).forEach(item => {
      if (item && typeof item.question === 'string') {
        embed.addFields({ name: item.question.substring(0, 250), value: String(item.answer ?? 'N/A').substring(0, 1020), inline: false });
      }
    });

    await channel.send({ embeds: [embed], components: [row] });
    return res.status(200).json({ success: true, message: 'Đã gửi' });
  } catch (error) {
    console.error('❌ Lỗi:', error);
    return res.status(500).json({ error: 'Lỗi server' });
  }
});

client.login(process.env.DISCORD_TOKEN);
app.listen(process.env.PORT || 3000, () => console.log(`🚀 Server đang chạy!`));