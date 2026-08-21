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
  if (!cachedGuild) {
    console.warn('⚠️ GUILD_ID không hợp lệ hoặc bot chưa được add vào server');
  }
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
      return interaction.followUp({
        content: '❌ Không tìm thấy Server Discord hoặc GUILD_ID không hợp lệ!',
        ephemeral: true
      });
    }

    const member = await guild.members.fetch(discordUserId).catch(() => null);
    if (!member) {
      return interaction.followUp({
        content: '❌ Không tìm thấy thành viên trong server!',
        ephemeral: true
      });
    }

    if (action === 'approve') {
      const botMember = await guild.members.fetchMe();
      if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
        return interaction.followUp({
          content: '❌ Bot thiếu quyền Manage Roles để cấp role!',
          ephemeral: true
        });
      }

      let rolesToAdd = [];

      // SỬA 1: Nếu nút bấm CÓ chứa targetRoleId -> CHỈ cấp duy nhất Role đó, tuyệt đối không lấy danh sách mặc định
      if (targetRoleId && /^\d{17,19}$/.test(targetRoleId)) {
        const matchedRole = await guild.roles.fetch(targetRoleId).catch(() => null);
        if (matchedRole) {
          rolesToAdd.push(matchedRole.id);
        } else {
          return interaction.followUp({
            content: `❌ Role có ID \`${targetRoleId}\` không tồn tại trong Server!`,
            ephemeral: true
          });
        }
      } else {
        // Chỉ khi nút bấm hoàn toàn không chứa targetRoleId mới dùng danh sách mặc định
        rolesToAdd = parseRoleIds(process.env.ROLE_APPROVED_ID);
      }

      if (rolesToAdd.length === 0) {
        return interaction.followUp({
          content: '❌ Không tìm thấy ID Role hợp lệ để cấp!',
          ephemeral: true
        });
      }

      await member.roles.add(rolesToAdd);

      await updateButtonState(
        interaction,
        `Đã duyệt bởi ${interaction.user.username}`,
        ButtonStyle.Success
      );

      await interaction.followUp({
        content: `✅ Đã cấp Role (${rolesToAdd.join(', ')}) cho <@${discordUserId}>!`,
        ephemeral: true
      });
      return;
    }

    if (action === 'reject') {
      const rejectedRoleIds = parseRoleIds(process.env.ROLE_REJECTED_ID);

      if (rejectedRoleIds.length > 0) {
        await member.roles.add(rejectedRoleIds);
      }

      await updateButtonState(
        interaction,
        `Đã từ chối bởi ${interaction.user.username}`,
        ButtonStyle.Danger
      );

      await interaction.followUp({
        content: `❌ Đã từ chối đơn của <@${discordUserId}>.`,
        ephemeral: true
      });
      return;
    }
  } catch (error) {
    console.error('❌ Lỗi khi xử lý interaction:', error);
    
    const errorMessage = error.code === 50013 
      ? '❌ Vị trí Role của Bot đứng dưới Role cần cấp trong Server Settings!'
      : '❌ Đã xảy ra lỗi hệ thống khi xử lý yêu cầu.';

    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: errorMessage, ephemeral: true }).catch(() => {});
    } else {
      await interaction.reply({ content: errorMessage, ephemeral: true }).catch(() => {});
    }
  }
});

app.post('/submit-form', async (req, res) => {
  try {
    console.log('📥 Nhận request /submit-form:', JSON.stringify(req.body, null, 2));
    
    const { secret, username, discordUserId, answers = [] } = req.body || {};

    if (secret !== process.env.WEBHOOK_SECRET) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const guild = await getGuild();
    if (!guild) {
      return res.status(500).json({ error: 'Không tìm thấy Guild' });
    }

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

        if (foundMember) {
          finalUserId = foundMember.id;
        }
      } catch (err) {
        console.error('❌ Lỗi khi tìm kiếm member:', err.message);
      }
    }

    if (!finalUserId) {
      return res.status(400).json({ error: 'Không tìm thấy Member trong Server Discord!' });
    }

    if (!process.env.DISCORD_CHANNEL_ID) {
      return res.status(500).json({ error: 'DISCORD_CHANNEL_ID chưa được cấu hình' });
    }

    const channel = await client.channels.fetch(process.env.DISCORD_CHANNEL_ID).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      return res.status(500).json({ error: 'Channel không hợp lệ' });
    }

    const guildRoles = await guild.roles.fetch().catch(() => null);

    let selectedRoleId = '';
    // SỬA 2: Dùng match(/\d{17,19}/) để bóc tách ID Role ngay cả khi câu trả lời có chứa thêm văn bản khác
    for (const item of answers) {
      const ans = String(item.answer || '').trim();
      const extractedMatch = ans.match(/\d{17,19}/);
      
      if (extractedMatch) {
        const possibleRoleId = extractedMatch[0];
        // Chỉ chấp nhận nếu ID này thực sự tồn tại trong Server
        if (guildRoles && guildRoles.has(possibleRoleId)) {
          selectedRoleId = possibleRoleId;
          break;
        }
      }
    }

    console.log(`📌 ID Role được tìm thấy từ Form: "${selectedRoleId || 'Không có (Sử dụng mặc định)'}"`);

    const approveCustomId = selectedRoleId 
      ? `approve_${finalUserId}_${selectedRoleId}` 
      : `approve_${finalUserId}`;

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(approveCustomId)
        .setLabel('Duyệt')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`reject_${finalUserId}`)
        .setLabel('Từ chối')
        .setStyle(ButtonStyle.Danger)
    );

    const displayUser = username ? `${username} (<@${finalUserId}>)` : `<@${finalUserId}>`;

    const embed = new EmbedBuilder()
      .setTitle('📋 ĐƠN ĐĂNG KÝ MỚI')
      .setColor(0x3498db)
      .setTimestamp()
      .addFields({ name: 'Người gửi', value: displayUser });

    const safeAnswers = answers.slice(0, 24);
    for (const item of safeAnswers) {
      if (!item || typeof item.question !== 'string') continue;
      
      const qTitle = item.question.substring(0, 250);
      const qAnswer = String(item.answer ?? 'N/A').substring(0, 1020);

      embed.addFields({
        name: qTitle,
        value: qAnswer || 'Chưa trả lời',
        inline: false
      });
    }

    await channel.send({ embeds: [embed], components: [row] });
    return res.status(200).json({ success: true, message: 'Đã gửi đơn thành công' });
  } catch (error) {
    console.error('❌ Lỗi khi gửi form:', error);
    return res.status(500).json({ error: 'Lỗi server khi xử lý form' });
  }
});

if (!process.env.DISCORD_TOKEN) {
  console.error('❌ DISCORD_TOKEN chưa được cấu hình.');
  process.exit(1);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server đang chạy trên cổng ${PORT}`);
  client.login(process.env.DISCORD_TOKEN);
});

process.on('SIGTERM', async () => {
  await client.destroy();
  process.exit(0);
});

process.on('SIGINT', async () => {
  await client.destroy();
  process.exit(0);
});