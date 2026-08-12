const express = require('express');
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const app = express();
app.use(express.json());

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages
    ]
});

// Khi Bot sẵn sàng
client.once('ready', () => {
    console.log(`Bot đã đăng nhập thành công: ${client.user.tag}`);
});

// Xử lý sự kiện bấm nút trên Discord
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;

    const [action, discordUserId] = interaction.customId.split('_');
    const guild = client.guilds.cache.get(process.env.GUILD_ID);

    if (!guild) {
        return interaction.reply({ content: 'Không tìm thấy Server Discord!', ephemeral: true });
    }

    try {
        const member = await guild.members.fetch(discordUserId);

        if (action === 'approve') {
            const roleId = process.env.ROLE_APPROVED_ID;
            await member.roles.add(roleId);

            // Đổi nút thành trạng thái Đã duyệt
            const disabledRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('approved_done')
                    .setLabel(`Đã duyệt bởi ${interaction.user.username}`)
                    .setStyle(ButtonStyle.Success)
                    .setDisabled(true)
            );

            await interaction.update({ components: [disabledRow] });
            await interaction.followUp({ content: `✅ Đã cấp Role thành công cho <@${discordUserId}>!`, ephemeral: true });

        } else if (action === 'reject') {
            if (process.env.ROLE_REJECTED_ID) {
                await member.roles.add(process.env.ROLE_REJECTED_ID);
            }

            // Đổi nút thành trạng thái Đã từ chối
            const disabledRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('rejected_done')
                    .setLabel(`Đã từ chối bởi ${interaction.user.username}`)
                    .setStyle(ButtonStyle.Danger)
                    .setDisabled(true)
            );

            await interaction.update({ components: [disabledRow] });
            await interaction.followUp({ content: `❌ Đã từ chối đơn của <@${discordUserId}>.`, ephemeral: true });
        }
    } catch (error) {
        console.error(error);
        await interaction.reply({ content: `❌ Lỗi: Không tìm thấy thành viên hoặc Bot thiếu quyền cấp Role!`, ephemeral: true });
    }
});

// API nhận thông tin từ Google Form
app.post('/submit-form', async (req, res) => {
    const { secret, username, discordUserId, answers } = req.body;

    if (secret !== process.env.WEBHOOK_SECRET) {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    const channel = client.channels.cache.get(process.env.DISCORD_CHANNEL_ID);
    if (!channel) {
        return res.status(500).json({ error: 'Channel không tồn tại' });
    }

    // Tạo các Nút bấm
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

    // Chuẩn bị nội dung Embed
    const embed = {
        title: '📋 ĐƠN DĂNG KÝ MỚI',
        fields: [
            { name: 'Người gửi', value: `${username} (<@${discordUserId}>)`, inline: false },
            ...answers.map(a => ({ name: a.question, value: a.answer || 'N/A', inline: false }))
        ],
        color: 0x3498db,
        timestamp: new Date()
    };

    await channel.send({ embeds: [embed], components: [row] });
    res.json({ success: true });
});

client.login(process.env.DISCORD_TOKEN);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));