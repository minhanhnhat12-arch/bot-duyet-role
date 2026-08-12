const express = require('express');
const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder
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
  if (guild) {
    cachedGuild = guild;  // Cập nhật cache nếu fetch thành công
  }
  return guild;
}

async function disableButtons(interaction, label, style) {
  const disabledRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('done')
      .setLabel(label)
      .setStyle(style)
      .setDisabled(true)
  );

  await interaction.update({ components: [disabledRow] });
}

client.once('ready', () => {
  console.log(`✅ Bot đã đăng nhập thành công: ${client.user.tag}`);
  
  // Cache guild
  cachedGuild = client.guilds.cache.get(process.env.GUILD_ID);
  if (!cachedGuild) {
    console.warn('⚠️  GUILD_ID không hợp lệ hoặc bot chưa được add vào server');
  }
  
  // Validate role IDs
  const approvedRoles = parseRoleIds(process.env.ROLE_APPROVED_ID);
  const rejectedRoles = parseRoleIds(process.env.ROLE_REJECTED_ID);
  
  if (approvedRoles.length === 0) {
    console.warn('⚠️  ROLE_APPROVED_ID chưa được cấu hình hoặc rỗng');
  } else {
    console.log(`✅ Approved roles: ${approvedRoles.join(', ')}`);
  }
  
  if (rejectedRoles.length > 0) {
    console.log(`✅ Rejected roles: ${rejectedRoles.join(', ')}`);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  const parts = interaction.customId.split('_');
  if (parts.length < 2) return;

  const [action, discordUserId] = parts;
  if (!discordUserId) return;

  try {
    const guild = await getGuild();
    if (!guild) {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: '❌ Không tìm thấy Server Discord hoặc GUILD_ID không hợp lệ!',
          ephemeral: true
        });
      }
      return;
    }

    const member = await guild.members.fetch(discordUserId).catch(() => null);
    if (!member) {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: '❌ Không tìm thấy thành viên trong server hoặc ID không hợp lệ!',
          ephemeral: true
        });
      }
      return;
    }

    if (action === 'approve') {
      const approvedRoleIds = parseRoleIds(process.env.ROLE_APPROVED_ID);

      if (approvedRoleIds.length === 0) {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({
            content: '❌ ROLE_APPROVED_ID chưa được cấu hình!',
            ephemeral: true
          });
        }
        return;
      }

      // Kiểm tra quyền bot trước khi assign role
      const botMember = await guild.members.fetchMe();
      if (!botMember.permissions.has('ManageRoles')) {
        console.error('❌ Bot thiếu quyền ManageRoles!');
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({
            content: '❌ Bot thiếu quyền Manage Roles để cấp role!',
            ephemeral: true
          });
        }
        return;
      }

      await member.roles.add(approvedRoleIds);
      await disableButtons(
        interaction,
        `Đã duyệt bởi ${interaction.user.username}`,
        ButtonStyle.Success
      );

      await interaction.followUp({
        content: `✅ Đã cấp Role thành công cho <@${discordUserId}>!`,
        ephemeral: true
      });
      return;
    }

    if (action === 'reject') {
      const rejectedRoleIds = parseRoleIds(process.env.ROLE_REJECTED_ID);

      if (rejectedRoleIds.length > 0) {
        await member.roles.add(rejectedRoleIds);
      }

      await disableButtons(
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
    console.error('Lỗi khi xử lý interaction:', error);

    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: '❌ Lỗi: Bot không thể cấp Role hoặc thiếu quyền Manage Roles!',
        ephemeral: true
      });
    }
  }
});

app.post('/submit-form', async (req, res) => {
  try {
    console.log('📥 Nhận request /submit-form:', JSON.stringify(req.body, null, 2));
    
    const { secret, username, discordUserId, answers = [] } = req.body || {};

    if (secret !== process.env.WEBHOOK_SECRET) {
      console.warn('❌ Secret không match. Nhận:', secret, 'Kỳ vọng:', process.env.WEBHOOK_SECRET);
      return res.status(403).json({ error: 'Unauthorized' });
    }

    // Lấy guild
    const guild = await getGuild();
    if (!guild) {
      console.error('❌ Không tìm thấy Guild');
      return res.status(500).json({ error: 'Không tìm thấy Guild' });
    }

    let finalUserId = discordUserId;

    // Nếu không có ID dạng số, tiến hành tìm kiếm thông minh theo Username/Nickname
    if (!finalUserId || !/^\d{17,19}$/.test(finalUserId)) {
      console.log(`⚠️ discordUserId không có. Bắt đầu tìm Member theo tên: "${username}"`);
      
      try {
        // Tải TOÀN BỘ member trong server về (không giới hạn 1000 người)
        const members = await guild.members.fetch({ force: true });
        const cleanInput = String(username || '').toLowerCase().replace('@', '').trim();

        const foundMember = members.find(m => {
          const uName = m.user.username ? m.user.username.toLowerCase() : '';
          const gName = m.user.globalName ? m.user.globalName.toLowerCase() : '';
          const nick = m.nickname ? m.nickname.toLowerCase() : '';

          // So sánh khớp với Username gốc, Global Name hoặc Nickname trong server
          return uName === cleanInput || gName === cleanInput || nick === cleanInput;
        });

        if (foundMember) {
          finalUserId = foundMember.id;
          console.log(`✅ Tìm thấy Member: ${foundMember.user.tag} (ID: ${finalUserId})`);
        } else {
          console.warn(`⚠️ Không tìm thấy Member nào khớp với tên: "${cleanInput}"`);
        }
      } catch (err) {
        console.error('❌ Lỗi khi quét danh sách members:', err.message);
      }
    }

    if (!finalUserId) {
      console.error('❌ Không tìm thấy finalUserId');
      return res.status(400).json({ error: 'Không tìm thấy Member trong Server Discord!' });
    }

    if (!process.env.DISCORD_CHANNEL_ID) {
      return res.status(500).json({ error: 'DISCORD_CHANNEL_ID chưa được cấu hình' });
    }

    const channel = await client.channels.fetch(process.env.DISCORD_CHANNEL_ID).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      return res.status(500).json({ error: 'Channel không hợp lệ' });
    }

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`approve_${finalUserId}`)
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

    for (const item of answers) {
      if (!item || typeof item.question !== 'string') continue;
      embed.addFields({
        name: item.question,
        value: String(item.answer ?? 'N/A'),
        inline: false
      });
    }

    await channel.send({ embeds: [embed], components: [row] });
    console.log('✅ Gửi embed thành công!');

    return res.status(200).json({ success: true, message: 'Đã gửi đơn thành công' });
  } catch (error) {
    console.error('❌ Lỗi khi gửi form:', error);
    return res.status(500).json({ error: 'Lỗi server khi xử lý form' });
  }
});

if (!process.env.DISCORD_TOKEN) {
  console.error('❌ DISCORD_TOKEN chưa được cấu hình. Hãy thêm biến môi trường vào .env hoặc hosting');
  process.exit(1);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server đang chạy trên cổng ${PORT}`);
  console.log(`📡 Endpoint: POST http://localhost:${PORT}/submit-form`);
  console.log('⏳ Đang đợi bot login...');
  client.login(process.env.DISCORD_TOKEN);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('⏹️  Nhận tín hiệu SIGTERM, đang tắt...');
  await client.destroy();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('⏹️  Nhận tín hiệu SIGINT, đang tắt...');
  await client.destroy();
  process.exit(0);
});