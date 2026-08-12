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
  if (!process.env.GUILD_ID) {
    throw new Error('GUILD_ID chưa được cấu hình');
  }

  const guild = await client.guilds.fetch(process.env.GUILD_ID).catch(() => null);
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
    const { secret, username, discordUserId, answers = [] } = req.body || {};

    if (secret !== process.env.WEBHOOK_SECRET) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    if (!username || !discordUserId) {
      return res.status(400).json({ error: 'Thiếu username hoặc discordUserId' });
    }

    if (!process.env.DISCORD_CHANNEL_ID) {
      return res.status(500).json({ error: 'DISCORD_CHANNEL_ID chưa được cấu hình' });
    }

    const channel = await client.channels.fetch(process.env.DISCORD_CHANNEL_ID).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      return res.status(500).json({ error: 'Channel không tồn tại hoặc không hỗ trợ gửi tin nhắn' });
    }

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`approve_${discordUserId}`)
        .setLabel('Duyệt')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`reject_${discordUserId}`)
        .setLabel('Từ chối')
        .setStyle(ButtonStyle.Danger)
    );

    const embed = new EmbedBuilder()
      .setTitle('📋 ĐƠN ĐĂNG KÝ MỚI')
      .setColor(0x3498db)
      .setTimestamp()
      .addFields({ name: 'Người gửi', value: `${username} (<@${discordUserId}>)` });

    for (const item of answers) {
      if (!item || typeof item.question !== 'string') continue;
      embed.addFields({
        name: item.question,
        value: String(item.answer ?? 'N/A'),
        inline: false
      });
    }

    await channel.send({ embeds: [embed], components: [row] });

    return res.status(200).json({ success: true, message: 'Đã gửi đơn thành công' });
  } catch (error) {
    console.error('Lỗi khi gửi form:', error);
    return res.status(500).json({ error: 'Lỗi server khi xử lý form' });
  }
});

if (!process.env.DISCORD_TOKEN) {
  console.error('❌ DISCORD_TOKEN chưa được cấu hình. Hãy thêm biến môi trường vào .env hoặc hosting');
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server đang chạy trên cổng ${PORT}`);
});