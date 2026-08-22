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

      // Tách danh sách nhiều ID Role (phân cách bằng dấu '-') từ nút bấm
      if (targetRoleId) {
        const rawRoleIds = targetRoleId.split('-');
        for (const rId of rawRoleIds) {
          if (/^\d{17,19}$/.test(rId)) {
            const matchedRole = await guild.roles.fetch(rId).catch(() => null);
            if (matchedRole) rolesToAdd.push(matchedRole.id);
          }
        }
      }

      // Dự phòng: Nếu không có Role nào từ Form mới lấy Role mặc định trong .env
      if (rolesToAdd.length === 0) {
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

      const formattedRoles = rolesToAdd.map(id => `<@&${id}>`).join(', ');

      await interaction.followUp({
        content: `✅ Đã cấp các Role (${formattedRoles}) cho <@${discordUserId}>!`,
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
    let selectedRoleIds = [];

    if (guildRoles) {
      for (const item of answers) {
        const ans = String(item.answer || '').trim();
        if (!ans) continue;

        // Tách câu trả lời thành từng phần nếu chọn nhiều lựa chọn (phân cách bằng dấu phẩy hoặc xuống dòng)
        const answerParts = ans.split(/,|\n/).map(s => s.trim()).filter(Boolean);

        for (const part of answerParts) {
          // 1. Quét ID dãy số
          const idMatches = part.match(/\d{17,19}/g);
          if (idMatches) {
            for (const possibleId of idMatches) {
              if (guildRoles.has(possibleId) && !selectedRoleIds.includes(possibleId)) {
                selectedRoleIds.push(possibleId);
              }
            }
          }

          // 2. Quét theo Tên Role
          const cleanPart = part.toLowerCase();
          const matchedByName = guildRoles.find(role => 
            !role.managed && 
            role.name !== '@everyone' && 
            (role.name.toLowerCase().trim() === cleanPart || cleanPart.includes(role.name.toLowerCase().trim()))
          );

          if (matchedByName && !selectedRoleIds.includes(matchedByName.id)) {
            selectedRoleIds.push(matchedByName.id);
          }
        }
      }
    }

    console.log(`🎯 Các Role tìm thấy từ Form:`, selectedRoleIds);

    // Nối danh sách các Role ID bằng dấu "-" (đảm bảo không quá 100 ký tự giới hạn của Discord)
    const roleString = selectedRoleIds.join('-');
    const approveCustomId = roleString 
      ? `approve_${finalUserId}_${roleString}`.substring(0, 100)
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