export default {
  async fetch(request, env, ctx) {
    const BOT_TOKEN = env.BOT_TOKEN;
    const ADMIN_ID_ENV = env.ADMIN_ID;

    if (!BOT_TOKEN || !ADMIN_ID_ENV) {
      return new Response('请先在环境变量中配置 BOT_TOKEN 和 ADMIN_ID', { status: 500 });
    }

    const ADMIN_IDS = ADMIN_ID_ENV.split(',').map(id => id.trim());
    const apiUrl = `https://api.telegram.org/bot${BOT_TOKEN}`;
    const WEBHOOK_SECRET = BOT_TOKEN.replace(/[^a-zA-Z0-9]/g, '').substring(0, 32); // 🛡️ 核心防卫: 自动生成 Webhook 专属暗号

    const tgReq = async (method, payload) => {
      const res = await fetch(`${apiUrl}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      return res.json();
    };

    const url = new URL(request.url);

    // ==========================================
    // 0. 初始化与 Webhook
    // ==========================================
    if (request.method === 'GET' && url.pathname === '/init') {
      const webhookUrl = `https://${url.hostname}/webhook`;
      const res = await tgReq('setWebhook', { url: webhookUrl, secret_token: WEBHOOK_SECRET });

      await tgReq('setMyCommands', {
        commands: [{ command: 'start', description: '开始使用 / 呼出服务菜单' }],
        scope: { type: 'default' }
      });

      const adminCommands = [
        { command: 'chat', description: '📱 呼出联系人面板锁定单聊' },
        { command: 'end', description: '⏹ 退出锁定单聊模式' },
        { command: 'stats', description: '📊 查看系统运行状态数据' },
        { command: 'blocklog', description: '🛡️ 查看详细拦截与错误记录' },
        { command: 'dnd', description: '🔕 开关: 离开/免打扰模式' },
        { command: 'media', description: '🖼️ 开关: 纯文本/媒体拦截' },
        { command: 'kwlist', description: '🤖 查看已设置的自动回复词' },
        { command: 'history', description: '🕒 查看特定用户最近消息 (/history ID)' },
        { command: 'note', description: '📝 设置用户备注 (/note ID 备注)' },
        { command: 'addkw', description: '➕ 添加自动回复 (/addkw 词 回复)' },
        { command: 'delkw', description: '➖ 删除自动回复 (/delkw 词)' },
        { command: 'ban', description: '🚫 永久拉黑用户 (/ban ID)' },
        { command: 'unban', description: '✅ 解除拉黑用户 (/unban ID)' },
        { command: 'unverify', description: '🧹 清除验证状态 (/unverify ID)' },
        { command: 'deluser', description: '🗑️ 从列表移除联系人 (/deluser ID)' },
        { command: 'clearlist', description: '🧹 清空所有联系人记录' },
        { command: 'setwelcome', description: '💬 自定义欢迎语 (/setwelcome 内容)' },
        { command: 'setfaq1', description: '💬 设常见问题文案 (/setfaq1 内容)' },
        { command: 'setfaq2', description: '💬 设发货说明文案 (/setfaq2 内容)' },
        { command: 'setcaptcha', description: '🔄 设验证模式 (/setcaptcha random/math/find/fruit)' },
        { command: 'setmaxfails', description: '⛔ 设容错拉黑次数 (/setmaxfails 3)' },
        { command: 'addspam', description: '⛔ 添加违禁词拉黑 (/addspam 词)' },
        { command: 'delspam', description: '❎ 删除违禁词 (/delspam 词)' },
        { command: 'spamlist', description: '📋 查看违禁词表' },
        { command: 'spamalert', description: '🔕 开关: 自动拉黑报警(静默模式)' }, // 更新了描述
        { command: 'broadcast', description: '📢 全局广播通知 (/broadcast 内容)' },
        { command: 'burn', description: '🔥 阅后即焚消息 (/burn 内容)' }
      ];
      
      for (const adminId of ADMIN_IDS) {
        await tgReq('setMyCommands', { commands: adminCommands, scope: { type: 'chat', chat_id: adminId } });
      }

      return new Response(res.ok ? `✅ 初始化成功!\n1. Webhook 绑定成功: ${webhookUrl}\n2. 机器人超级菜单已更新!` : `❌ 失败: ${JSON.stringify(res)}`);
    }

    // ==========================================
    // 辅助函数定义
    // ==========================================
    const TTL = { expirationTtl: 2592000 }; // KV 30天自动过期清理

    const incStat = async (key) => {
      let val = await env.KV.get(`stat_${key}`) || 0;
      ctx.waitUntil(env.KV.put(`stat_${key}`, parseInt(val) + 1));
    };

    const addBlockLog = async (uid, name, reason, content) => {
      try {
        let logs = JSON.parse(await env.KV.get('log_blocks') || '[]');
        const d = new Date(Date.now() + 8 * 3600 * 1000);
        const time = `${(d.getUTCMonth()+1).toString().padStart(2,'0')}-${d.getUTCDate().toString().padStart(2,'0')} ${d.getUTCHours().toString().padStart(2,'0')}:${d.getUTCMinutes().toString().padStart(2,'0')}`;
        let safeContent = (content || '').substring(0, 30);
        if (content && content.length > 30) safeContent += '...';
        logs.unshift({ time, id: uid, name, reason, content: safeContent });
        if (logs.length > 20) logs.pop(); 
        ctx.waitUntil(env.KV.put('log_blocks', JSON.stringify(logs)));
      } catch (e) {}
    };

    // 智能发送管理员面板 (自动删掉旧面板，保持界面清爽)
    const sendAdminPanel = async (chatId, text, markup = null) => {
      const lastId = await env.KV.get(`last_panel_${chatId}`);
      if (lastId) ctx.waitUntil(tgReq('deleteMessage', { chat_id: chatId, message_id: lastId }));
      const payload = { chat_id: chatId, text, parse_mode: 'Markdown' };
      
      // 自动给所有面板加上“关闭”按钮
      const closeBtn = [{ text: '❌ 关闭面板', callback_data: 'close_panel' }];
      if (markup) {
         if (markup.inline_keyboard) markup.inline_keyboard.push(closeBtn);
         else markup.inline_keyboard = [closeBtn];
         payload.reply_markup = markup;
      } else {
         payload.reply_markup = { inline_keyboard: [closeBtn] };
      }
      
      const res = await tgReq('sendMessage', payload);
      if (res.ok) ctx.waitUntil(env.KV.put(`last_panel_${chatId}`, res.result.message_id.toString(), { expirationTtl: 86400 }));
    };

    // 访客自助 FAQ 菜单键盘
    const faqKeyboard = {
      inline_keyboard: [
        [{ text: '💰 常见问题与价格', callback_data: 'faq_1' }],
        [{ text: '📦 发货与售后说明', callback_data: 'faq_2' }],
        [{ text: '🙋 呼叫人工客服', callback_data: 'faq_human' }]
      ]
    };

    if (request.method === 'POST' && url.pathname === '/webhook') {
      // 🛡️ Webhook 安全鉴权: 核对暗号，拒绝一切外部直接访问伪造
      if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== WEBHOOK_SECRET) {
         return new Response('Unauthorized', { status: 401 });
      }

      let update;
      try { update = await request.json(); } catch (e) { return new Response('Bad Request'); }

      // ==========================================
      // 1. 处理回调查询 (按钮点击)
      // ==========================================
      if (update.callback_query) {
        const cb = update.callback_query;
        const userId = cb.from.id.toString();
        const isAdmin = ADMIN_IDS.includes(userId);
        const userName = [cb.from.first_name, cb.from.last_name].filter(Boolean).join(' ') || '未知用户';
        const lang = cb.from.language_code || 'en';
        const isZh = lang.startsWith('zh');

        // 黑名单拦截
        if (await env.KV.get(`banned_${userId}`)) return new Response('OK');

        // --- 销毁面板交互 (提取到最外层，修复管理员无法点击的BUG) ---
        if (cb.data === 'close_panel') {
          await tgReq('deleteMessage', { chat_id: userId, message_id: cb.message.message_id });
          return new Response('OK');
        }

        // --- 访客验证码相关 ---
        if (cb.data === 'captcha_pass') {
          await env.KV.put(`user_${userId}`, 'verified', TTL);
          ctx.waitUntil(env.KV.put(`user_info_${userId}`, userName, TTL));
          ctx.waitUntil(incStat('verified'));
          
          await tgReq('editMessageText', { 
            chat_id: userId, 
            message_id: cb.message.message_id, 
            text: isZh ? '✅ **验证通过！**\n\n请选择您需要的服务，或直接输入消息发送给人工客服：' : '✅ **Verified!**\n\nPlease select a service or type a message directly:',
            parse_mode: 'Markdown',
            reply_markup: faqKeyboard
          });
        } else if (cb.data === 'captcha_fail') {
          ctx.waitUntil(incStat('blocked'));
          let fails = parseInt(await env.KV.get(`fails_${userId}`) || '0') + 1;
          await env.KV.put(`fails_${userId}`, fails.toString(), { expirationTtl: 86400 }); // 保存24小时
          
          let maxFails = parseInt(await env.KV.get('sys_maxfails') || '3'); // 默认3次错误拉黑
          
          if (fails >= maxFails) {
            await env.KV.put(`banned_${userId}`, 'true'); // 触发拉黑
            ctx.waitUntil(addBlockLog(userId, userName, '多次验证错误拉黑', `连续失败 ${fails} 次`));
            await tgReq('editMessageText', { 
               chat_id: userId, message_id: cb.message.message_id, 
               text: isZh ? '🚫 **验证失败次数过多，您已被系统自动永久拦截。**' : '🚫 **Too many failed attempts. You are blocked.**', 
               parse_mode: 'Markdown' 
            });
            
            // 报警通知管理员 (受静默模式开关控制)
            const alertOn = await env.KV.get('sys_spamalert') !== 'off'; // 默认开启
            if (alertOn) {
                for (const admin of ADMIN_IDS) {
                   ctx.waitUntil(tgReq('sendMessage', { chat_id: admin, text: `🛡️ **防刷报警**\n\n访客 👤 **${userName}** (\`${userId}\`) 连续 ${fails} 次验证错误，已被自动拉黑。`, parse_mode: 'Markdown' }));
                }
            }
          } else {
            ctx.waitUntil(addBlockLog(userId, userName, '验证码错误', `第 ${fails} 次选错`));
            await tgReq('answerCallbackQuery', { 
               callback_query_id: cb.id, 
               text: isZh ? `❌ 算错了哦，请重试！\n(警告: 错误 ${maxFails} 次将被永久拉黑，当前 ${fails} 次)` : '❌ Wrong answer, try again', 
               show_alert: true 
            });
          }
        } 
        
        // --- 访客 FAQ 菜单交互 ---
        else if (cb.data.startsWith('faq_')) {
          const action = cb.data.replace('faq_', '');
          if (action === 'menu') {
            await tgReq('editMessageText', { chat_id: userId, message_id: cb.message.message_id, text: '👇 **自助服务菜单**\n请选择您需要了解的内容：', parse_mode: 'Markdown', reply_markup: faqKeyboard });
          } else if (action === '1') {
            const faq1Text = await env.KV.get('faq_1_text') || '💰 **常见问题与价格**\n\n默认文案。管理员请发送 `/setfaq1 你的内容` 进行修改。';
            await tgReq('editMessageText', { 
              chat_id: userId, message_id: cb.message.message_id, 
              text: faq1Text, 
              parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 返回菜单', callback_data: 'faq_menu' }]] } 
            });
          } else if (action === '2') {
            const faq2Text = await env.KV.get('faq_2_text') || '📦 **发货与售后说明**\n\n默认文案。管理员请发送 `/setfaq2 你的内容` 进行修改。';
            await tgReq('editMessageText', { 
              chat_id: userId, message_id: cb.message.message_id, 
              text: faq2Text, 
              parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 返回菜单', callback_data: 'faq_menu' }]] } 
            });
          } else if (action === 'human') {
            await tgReq('editMessageText', { 
              chat_id: userId, message_id: cb.message.message_id, 
              text: '👩‍💻 **已为您接通人工客服**\n\n请直接在下方输入您的问题，主人收到后会尽快给您回复！', 
              parse_mode: 'Markdown' 
            });
          }
        }

        // --- 管理员快捷按钮交互 ---
        else if (isAdmin) {
          if (cb.data.startsWith('setchat_')) {
            const targetId = cb.data.replace('setchat_', '');
            await env.KV.put(`active_chat_${userId}`, targetId);
            const targetName = await env.KV.get(`user_info_${targetId}`) || '该用户';
            const note = await env.KV.get(`note_${targetId}`);
            
            await tgReq('editMessageText', {
              chat_id: userId, message_id: cb.message.message_id,
              text: `✅ **已锁定对话**\n\n正在与 👤 **${note ? `${note} (${targetName})` : targetName}** (\`${targetId}\`) 聊天。\n\n退出发 \`/end\`，剧透阅后即焚发 \`/burn 内容\``,
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: '📝 备注', callback_data: `qnote_${targetId}` },
                    { text: '🚫 拉黑', callback_data: `qban_${targetId}` },
                    { text: '🗑️ 删除', callback_data: `qdel_${targetId}` }
                  ],
                  [{ text: '❌ 关闭面板', callback_data: 'close_panel' }]
                ]
              }
            });
          } else if (cb.data.startsWith('qdel_')) {
            const targetId = cb.data.replace('qdel_', '');
            await env.KV.delete(`user_info_${targetId}`);
            await env.KV.delete(`history_${targetId}`);
            await env.KV.delete(`note_${targetId}`);
            // 如果删除的正是当前锁定的聊天，则自动退出锁定
            if (await env.KV.get(`active_chat_${userId}`) === targetId) {
                await env.KV.delete(`active_chat_${userId}`);
            }
            await tgReq('answerCallbackQuery', { callback_query_id: cb.id, text: '🗑️ 成功：已将该访客从联系人列表中移除', show_alert: true });
            await tgReq('deleteMessage', { chat_id: userId, message_id: cb.message.message_id });
          } else if (cb.data.startsWith('qban_')) {
            const targetId = cb.data.replace('qban_', '');
            await env.KV.put(`banned_${targetId}`, 'true');
            await tgReq('answerCallbackQuery', { callback_query_id: cb.id, text: '🚫 拦截成功：已将该用户永久拉黑', show_alert: true });
            // 移除原本消息上的按钮，防止重复点击
            await tgReq('editMessageReplyMarkup', { chat_id: userId, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } });
          } else if (cb.data.startsWith('qnote_')) {
            const targetId = cb.data.replace('qnote_', '');
            await tgReq('answerCallbackQuery', { callback_query_id: cb.id, text: `📝 请在输入框发送指令：\n/note ${targetId} 你的备注名`, show_alert: true });
          } else if (cb.data === 'clear_stats') {
            await env.KV.delete('stat_verified');
            await env.KV.delete('stat_blocked');
            await env.KV.delete('stat_msgs');
            await tgReq('answerCallbackQuery', { callback_query_id: cb.id, text: '🧹 所有统计数据已清零！', show_alert: true });
            await sendAdminPanel(userId, '📊 统计数据已被手动清空。');
          } else if (cb.data === 'bc_confirm') {
            // 📢 广播发送确认执行
            const bcMsgId = await env.KV.get(`pending_bc_${userId}`);
            if (!bcMsgId) return new Response('OK');
            await tgReq('editMessageText', { chat_id: userId, message_id: cb.message.message_id, text: '⏳ 正在拼命群发中，请稍候...' });
            let count = 0;
            for (const k of (await env.KV.list({ prefix: 'user_' })).keys) {
              if (!k.name.startsWith('user_info_')) {
                ctx.waitUntil(tgReq('copyMessage', { chat_id: k.name.replace('user_', ''), from_chat_id: userId, message_id: bcMsgId }));
                count++;
              }
            }
            await env.KV.delete(`pending_bc_${userId}`);
            await tgReq('deleteMessage', { chat_id: userId, message_id: cb.message.message_id });
            await sendAdminPanel(userId, `✅ **广播完成**\n\n已成功将该消息投递给 ${count} 位联系人。`);
          } else if (cb.data === 'bc_cancel') {
            // 📢 取消广播
            await env.KV.delete(`pending_bc_${userId}`);
            await tgReq('deleteMessage', { chat_id: userId, message_id: cb.message.message_id });
            await sendAdminPanel(userId, '❌ 广播任务已取消。');
          }
        }
        
        return new Response('OK');
      }

      // ==========================================
      // 2. 处理普通消息
      // ==========================================
      if (update.message) {
        if (update.message.chat.type !== 'private') {
           // 🛡️ 自动退群隔离保护
           await tgReq('leaveChat', { chat_id: update.message.chat.id });
           for (const admin of ADMIN_IDS) {
               ctx.waitUntil(tgReq('sendMessage', { chat_id: admin, text: `🛡️ **群组隔离保护**\n\n检测到非私聊环境，已自动退出群组: ${update.message.chat.title || '未知群'} (${update.message.chat.id})` }));
           }
           return new Response('OK');
        }

        const msg = update.message;
        const userId = msg.from.id.toString();
        const msgId = msg.message_id;
        const isAdmin = ADMIN_IDS.includes(userId);
        const userName = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || '未知用户';

        // ----------------------------------------
        // 【管理员控制台逻辑】
        // ----------------------------------------
        if (isAdmin) {
          const text = (msg.text || msg.caption || '').trim();
          if (text) {
            const cmd = text.split(' ')[0];

            // 自动清理管理员的命令消息，保持聊天框整洁
            if (text.startsWith('/')) {
               ctx.waitUntil(tgReq('deleteMessage', { chat_id: userId, message_id: msgId }));
            }

            if (cmd === '/chat' || cmd === '/list') {
              const listRes = await env.KV.list({ prefix: 'user_info_' });
              const keyboard = [];
              for (const k of listRes.keys) {
                if (keyboard.length >= 20) break; // 最多显示20人
                const uid = k.name.replace('user_info_', '');
                if (await env.KV.get(`banned_${uid}`)) continue; // 🌟 自动过滤掉已拉黑的用户
                const uname = await env.KV.get(k.name) || '未知';
                const note = await env.KV.get(`note_${uid}`);
                keyboard.push([{ text: note ? `📝 ${note}` : `👤 ${uname}`, callback_data: `setchat_${uid}` }]);
              }
              await sendAdminPanel(userId, keyboard.length ? '👇 **请选择要对话的联系人：**' : '暂无联系人记录。', { inline_keyboard: keyboard });
              return new Response('OK');
            }
            
            if (cmd === '/end') {
              await env.KV.delete(`active_chat_${userId}`);
              await sendAdminPanel(userId, '⏹ 已退出聊天模式。');
              return new Response('OK');
            }

            if (cmd === '/stats') {
              const verified = await env.KV.get('stat_verified') || 0;
              const blocked = await env.KV.get('stat_blocked') || 0;
              const msgs = await env.KV.get('stat_msgs') || 0;
              const dnd = await env.KV.get('sys_dnd') === 'on' ? '开启 🟢' : '关闭 🔴';
              const media = await env.KV.get('sys_mediafilter') === 'on' ? '开启 (拦截媒体) 🟢' : '关闭 🔴';
              const statText = `📊 **系统运行统计**\n\n✅ 已验证人数: \`${verified}\`\n🚫 拦截总次数: \`${blocked}\`\n💬 处理消息总数: \`${msgs}\`\n\n🔕 免打扰模式: ${dnd}\n🖼️ 纯文本模式: ${media}\n\n👉 发送 \`/blocklog\` 查看最新详细拦截记录。`;
              await sendAdminPanel(userId, statText, { inline_keyboard: [[{ text: '🧹 清空所有统计数据', callback_data: 'clear_stats' }]] });
              return new Response('OK');
            }

            if (cmd === '/blocklog' || cmd === '/logs') {
              const logsStr = await env.KV.get('log_blocks');
              if (!logsStr || JSON.parse(logsStr).length === 0) {
                await sendAdminPanel(userId, '📭 暂无近期拦截与错误记录。');
                return new Response('OK');
              }
              const reply = JSON.parse(logsStr).map((l, i) => `${i+1}. [${l.time}] 👤 **${l.name}** (\`${l.id}\`)\n   🚫 ${l.reason}: _${l.content}_`).join('\n\n');
              await sendAdminPanel(userId, `🛡️ **近期拦截详情溯源 (最近20条)**\n\n${reply}`);
              return new Response('OK');
            }

            if (cmd === '/dnd') {
              const nextState = await env.KV.get('sys_dnd') === 'on' ? 'off' : 'on';
              await env.KV.put('sys_dnd', nextState);
              await sendAdminPanel(userId, `🔕 免打扰模式已 **${nextState === 'on' ? '开启' : '关闭'}**。`);
              return new Response('OK');
            }

            if (cmd === '/media') {
              const nextState = await env.KV.get('sys_mediafilter') === 'on' ? 'off' : 'on';
              await env.KV.put('sys_mediafilter', nextState);
              await sendAdminPanel(userId, `🖼️ 媒体拦截模式已 **${nextState === 'on' ? '开启' : '关闭'}**。`);
              return new Response('OK');
            }

            if (cmd === '/note') {
              const parts = text.split(' ');
              if (parts.length >= 3) {
                await env.KV.put(`note_${parts[1]}`, parts.slice(2).join(' '));
                await sendAdminPanel(userId, `📝 已将 \`${parts[1]}\` 备注为: **${parts.slice(2).join(' ')}**`);
              }
              return new Response('OK');
            }

            if (cmd === '/history') {
              const targetId = text.split(' ')[1];
              if (targetId) {
                const historyStr = await env.KV.get(`history_${targetId}`) || '[]';
                const reply = JSON.parse(historyStr).length ? JSON.parse(historyStr).map((m, i) => `${i+1}. ${m}`).join('\n') : '暂无文本聊天记录。';
                await sendAdminPanel(userId, `🕒 **最近消息记录**\n\n${reply}`);
              }
              return new Response('OK');
            }

            if (cmd === '/addkw' || cmd === '/delkw' || cmd === '/kwlist') {
              let kwMap = JSON.parse(await env.KV.get('auto_keywords') || '{}');
              if (cmd === '/addkw' && text.split(' ').length >= 3) {
                kwMap[text.split(' ')[1]] = text.split(' ').slice(2).join(' ');
                await env.KV.put('auto_keywords', JSON.stringify(kwMap));
                await sendAdminPanel(userId, `🤖 添加成功！将自动回复包含 "${text.split(' ')[1]}" 的消息。`);
              } else if (cmd === '/delkw' && text.split(' ')[1]) {
                delete kwMap[text.split(' ')[1]];
                await env.KV.put('auto_keywords', JSON.stringify(kwMap));
                await sendAdminPanel(userId, `🗑️ 已删除关键词 "${text.split(' ')[1]}"。`);
              } else if (cmd === '/kwlist') {
                const reply = Object.keys(kwMap).length ? Object.keys(kwMap).map(k => `- ${k}: ${kwMap[k]}`).join('\n') : '无';
                await sendAdminPanel(userId, `🤖 **自动回复关键词表:**\n${reply}`);
              }
              return new Response('OK');
            }

            if (cmd === '/addspam' || cmd === '/delspam' || cmd === '/spamlist') {
              let spamList = JSON.parse(await env.KV.get('spam_keywords') || '[]');
              if (cmd === '/addspam' && text.split(' ').length >= 2) {
                const word = text.split(' ').slice(1).join(' ');
                if (!spamList.includes(word)) spamList.push(word);
                await env.KV.put('spam_keywords', JSON.stringify(spamList));
                await sendAdminPanel(userId, `⛔ 添加违禁词成功！包含 "**${word}**" 的消息将自动被拦截并永久拉黑发送者。`);
              } else if (cmd === '/delspam' && text.split(' ').length >= 2) {
                const word = text.split(' ').slice(1).join(' ');
                spamList = spamList.filter(w => w !== word);
                await env.KV.put('spam_keywords', JSON.stringify(spamList));
                await sendAdminPanel(userId, `❎ 已删除违禁词 "**${word}**"。`);
              } else if (cmd === '/spamlist') {
                const reply = spamList.length ? spamList.map(w => `- ${w}`).join('\n') : '无';
                await sendAdminPanel(userId, `📋 **当前违禁词列表:**\n${reply}`);
              }
              return new Response('OK');
            }

            if (cmd === '/spamalert') {
              const nextState = await env.KV.get('sys_spamalert') === 'off' ? 'on' : 'off';
              await env.KV.put('sys_spamalert', nextState);
              await sendAdminPanel(userId, `🔕 自动拉黑报警已 **${nextState === 'on' ? '开启' : '关闭 (静默模式)'}**。\n\n关闭后，系统自动拉黑（违禁词/验证码多次错误）将不再发消息打扰你，只会悄悄记录到 \`/blocklog\` 中。`);
              return new Response('OK');
            }

            if (cmd === '/ban' || cmd === '/unban' || cmd === '/unverify') {
              const tid = text.split(' ')[1];
              if (tid) {
                if (cmd === '/ban') { await env.KV.put(`banned_${tid}`, 'true'); await sendAdminPanel(userId, `🚫 已永久拉黑 ${tid}`); }
                if (cmd === '/unban') { await env.KV.delete(`banned_${tid}`); await sendAdminPanel(userId, `✅ 已解除拉黑 ${tid}`); }
                if (cmd === '/unverify') { await env.KV.delete(`user_${tid}`); await sendAdminPanel(userId, `🧹 已清除 ${tid} 的验证状态`); }
              }
              return new Response('OK');
            }

            if (cmd === '/deluser') {
              const tid = text.split(' ')[1];
              if (tid) {
                await env.KV.delete(`user_info_${tid}`);
                await env.KV.delete(`history_${tid}`);
                await env.KV.delete(`note_${tid}`);
                await sendAdminPanel(userId, `🗑️ 已将用户 \`${tid}\` 的记录从联系人面板中抹除。`);
              }
              return new Response('OK');
            }

            if (cmd === '/clearlist') {
              const listRes = await env.KV.list({ prefix: 'user_info_' });
              let count = 0;
              for (const k of listRes.keys) {
                 ctx.waitUntil(env.KV.delete(k.name));
                 count++;
              }
              await sendAdminPanel(userId, `🧹 联系人列表已清空 (共清除 ${count} 条记录)。`);
              return new Response('OK');
            }

            if (cmd === '/setwelcome') {
              const w = text.substring(12).trim();
              if (w) { await env.KV.put('welcome_msg', w); await sendAdminPanel(userId, `✅ 欢迎语已更新`); }
              return new Response('OK');
            }

            if (cmd === '/setfaq1') {
              const w = text.substring(9).trim();
              if (w) { await env.KV.put('faq_1_text', w); await sendAdminPanel(userId, `✅ FAQ1 (常见问题) 内容已更新`); }
              return new Response('OK');
            }

            if (cmd === '/setfaq2') {
              const w = text.substring(9).trim();
              if (w) { await env.KV.put('faq_2_text', w); await sendAdminPanel(userId, `✅ FAQ2 (售后说明) 内容已更新`); }
              return new Response('OK');
            }

            if (cmd === '/setcaptcha') {
              const type = text.split(' ')[1];
              if (['random', 'math', 'find', 'fruit'].includes(type)) {
                await env.KV.put('sys_captcha_type', type);
                await sendAdminPanel(userId, `✅ 验证模式已切换为：**${type}**\n\n- random (随机混用)\n- math (加减法)\n- find (找特定表情)\n- fruit (数水果)`);
              } else {
                await sendAdminPanel(userId, `⚠️ 格式错误，请使用: \`/setcaptcha random\``, null);
              }
              return new Response('OK');
            }

            if (cmd === '/setmaxfails') {
              const num = parseInt(text.split(' ')[1]);
              if (!isNaN(num) && num > 0) {
                await env.KV.put('sys_maxfails', num.toString());
                await sendAdminPanel(userId, `✅ 验证容错次数已设为：**${num}** 次\n(访客选错 ${num} 次将自动永久拉黑)`);
              } else {
                await sendAdminPanel(userId, `⚠️ 格式错误，请使用: \`/setmaxfails 3\``, null);
              }
              return new Response('OK');
            }

            if (cmd === '/broadcast') {
              // 📢 广播升级：保存当前消息ID，发给面板确认 (支持图片/视频/文件附带文字)
              await env.KV.put(`pending_bc_${userId}`, msgId.toString(), { expirationTtl: 600 });
              await sendAdminPanel(userId, `📢 **广播发送确认**\n\n将把你的这条消息原封不动（支持带图/视频）群发给所有人。\n是否确认发送？`, {
                 inline_keyboard: [[{ text: '✅ 确认发送', callback_data: 'bc_confirm' }, { text: '❌ 取消', callback_data: 'bc_cancel' }]]
              });
              return new Response('OK');
            }

            // 剧透特效阅后即焚 (利用 HTML 的 tg-spoiler 标签)
            if (cmd === '/burn') {
              const activeChat = await env.KV.get(`active_chat_${userId}`);
              const burnMsg = text.substring(6).trim();
              if (activeChat && burnMsg) {
                await tgReq('sendMessage', { 
                  chat_id: activeChat, 
                  text: `🔥 <b>阅后即焚消息</b>\n\n<tg-spoiler>${burnMsg}</tg-spoiler>\n\n<i>(请手动点击马赛克区域查看内容)</i>`, 
                  parse_mode: 'HTML' 
                });
                await tgReq('sendMessage', { chat_id: userId, text: `🔥 剧透保护消息已发送给对方。` });
              } else {
                 await sendAdminPanel(userId, `⚠️ 请先使用 /chat 锁定用户，再使用 /burn <内容>`);
              }
              return new Response('OK');
            }
          }

          // 手动回复访客
          if (msg.reply_to_message && msg.reply_to_message.forward_from) {
            await tgReq('copyMessage', { chat_id: msg.reply_to_message.forward_from.id, from_chat_id: userId, message_id: msgId });
            return new Response('OK');
          } else if (msg.reply_to_message && !msg.reply_to_message.forward_from) {
            const textMatch = msg.reply_to_message.text ? msg.reply_to_message.text.match(/\(`(\d+)`\)/) : null;
            if (textMatch && textMatch[1]) {
               await tgReq('copyMessage', { chat_id: textMatch[1], from_chat_id: userId, message_id: msgId });
               return new Response('OK');
            }
          }

          // 锁定聊天发送
          const activeChat = await env.KV.get(`active_chat_${userId}`);
          if (activeChat) {
            await tgReq('copyMessage', { chat_id: activeChat, from_chat_id: userId, message_id: msgId });
          } else if (!text.startsWith('/')) {
            await tgReq('sendMessage', { chat_id: userId, text: 'ℹ️ **操作提示**\n当前未锁定聊天对象。请发送 `/chat`，或左滑回复用户消息。', parse_mode: 'Markdown' });
          }
          return new Response('OK');
        }

        // ----------------------------------------
        // 【普通访客逻辑】
        // ----------------------------------------
        ctx.waitUntil(incStat('msgs'));

        // 1. 黑名单检查
        if (await env.KV.get(`banned_${userId}`)) {
           ctx.waitUntil(incStat('blocked'));
           ctx.waitUntil(addBlockLog(userId, userName, '黑名单拦截', msg.text || '[媒体消息]'));
           return new Response('OK');
        }

        // 2. 媒体拦截检查与精准识别
        let mediaDesc = "";
        if (msg.photo) mediaDesc = "🖼️ 照片";
        else if (msg.voice) mediaDesc = "🎤 语音留言";
        else if (msg.video) mediaDesc = "🎬 视频";
        else if (msg.document) mediaDesc = "📄 文件";
        else if (msg.sticker) mediaDesc = "👾 贴纸";
        else if (msg.audio) mediaDesc = "🎵 音乐/音频";
        else if (msg.animation) mediaDesc = "🎞️ GIF动图";
        
        const mediaFilterOn = await env.KV.get('sys_mediafilter') === 'on';
        if (mediaFilterOn && mediaDesc !== "") {
           ctx.waitUntil(incStat('blocked'));
           ctx.waitUntil(addBlockLog(userId, userName, '媒体拦截', `尝试发送 ${mediaDesc}`));
           const lang = msg.from.language_code || 'en';
           await tgReq('sendMessage', { 
             chat_id: userId, 
             text: lang.startsWith('zh') ? `⚠️ 主人已开启纯文本模式，已被拦截发送 ${mediaDesc}。` : '⚠️ Owner only accepts text messages currently.',
             reply_to_message_id: msgId 
           });
           return new Response('OK');
        }

        // 3. 验证检查
        const isVerified = await env.KV.get(`user_${userId}`);
        const lang = msg.from.language_code || 'en';
        const isZh = lang.startsWith('zh');

        if (msg.text === '/start') {
           if (isVerified === 'verified') {
             await tgReq('sendMessage', { chat_id: userId, text: isZh ? '👇 **自助服务菜单**\n您可以自助查询，或直接输入消息发送给人工客服：' : '👇 **Service Menu**', reply_markup: faqKeyboard, parse_mode: 'Markdown' });
             return new Response('OK');
           }
        }

        if (isVerified === 'verified') {
          // 🛡️ 刷屏限流防卫 (10分钟冷冻)
          if (await env.KV.get(`flood_banned_${userId}`)) return new Response('OK');

          ctx.waitUntil(env.KV.put(`user_info_${userId}`, userName, TTL)); // 刷新活跃度
          const note = await env.KV.get(`note_${userId}`);
          const display = note ? `${note} (原名: ${userName})` : userName;

          // 记录频率 (5秒内>5条拉黑)
          let rateStr = await env.KV.get(`rate_${userId}`) || '[]';
          let rateArr = JSON.parse(rateStr);
          const now = Date.now();
          rateArr.push(now);
          rateArr = rateArr.filter(ts => now - ts < 5000);
          if (rateArr.length > 5) {
             await env.KV.put(`flood_banned_${userId}`, 'true', { expirationTtl: 600 });
             await env.KV.delete(`rate_${userId}`);
             await tgReq('sendMessage', { chat_id: userId, text: '⚠️ 发送过于频繁，为防止刷屏，您已被系统暂时禁言 10 分钟。' });
             for (const admin of ADMIN_IDS) {
                 ctx.waitUntil(tgReq('sendMessage', { chat_id: admin, text: `🚨 **刷屏限流报警**\n\n访客 👤 **${display}** (\`${userId}\`) 发送频率过高 (5秒内>5条)，已被系统自动冻结禁言 10 分钟。`, parse_mode: 'Markdown' }));
             }
             return new Response('OK');
          }
          ctx.waitUntil(env.KV.put(`rate_${userId}`, JSON.stringify(rateArr), { expirationTtl: 60 }));

          // 🌟 修复漏洞：同时提取纯文本和媒体的附带说明文字 (Caption) 进行屏蔽词检测
          const messageContent = (msg.text || msg.caption || "").toLowerCase();

          if (messageContent) {
             // 🛡️ 敏感词检测系统 (最高优先级，无视大小写)
             let spamList = JSON.parse(await env.KV.get('spam_keywords') || '[]');
             let isSpam = false;
             let matchedWord = "";
             for (const word of spamList) {
               if (messageContent.includes(word.toLowerCase())) { isSpam = true; matchedWord = word; break; }
             }
             
             if (isSpam) {
                await env.KV.put(`banned_${userId}`, 'true'); // 触发自动拉黑
                ctx.waitUntil(incStat('blocked'));
                ctx.waitUntil(addBlockLog(userId, userName, '违禁词封禁', messageContent));
                
                // 给管理员发报警 (受开关控制，且隐藏广告原文)
                const alertOn = await env.KV.get('sys_spamalert') !== 'off'; // 默认开启
                if (alertOn) {
                    for (const admin of ADMIN_IDS) {
                       ctx.waitUntil(tgReq('sendMessage', { 
                         chat_id: admin, 
                         text: `🛡️ **静默拦截通知**\n\n已自动拉黑发广告的访客 👤 **${display}** (\`${userId}\`)。\n\n🎯 **触发违禁词:** \`${matchedWord}\`\n\n*(广告原文本已折叠，如需查看请发送 /blocklog。若不想再收到此通知，可发送 /spamalert 关闭)*`, 
                         parse_mode: 'Markdown' 
                       }));
                    }
                }
                return new Response('OK'); // 直接丢弃该消息
             }

             // 正常记录历史文本 (仅记录文本)
             if (msg.text) {
               let historyStr = await env.KV.get(`history_${userId}`) || '[]';
               let history = JSON.parse(historyStr);
               history.push(msg.text.substring(0, 100));
               if (history.length > 5) history.shift();
               ctx.waitUntil(env.KV.put(`history_${userId}`, JSON.stringify(history), TTL));

               let kwMap = JSON.parse(await env.KV.get('auto_keywords') || '{}');
               for (const kw in kwMap) {
                  if (msg.text.includes(kw)) {
                    ctx.waitUntil(tgReq('sendMessage', { chat_id: userId, text: kwMap[kw], reply_to_message_id: msgId }));
                    break;
                  }
               }
             }
          }

          if (await env.KV.get('sys_dnd') === 'on') {
            ctx.waitUntil(tgReq('sendMessage', { chat_id: userId, text: isZh ? '🔕 主人目前正忙/休息中，消息已送达，将稍后回复您。' : '🔕 Owner is away. Message delivered.' }));
          }

          // 管理员快捷操作内联键盘
          const adminQuickActions = {
            inline_keyboard: [[
              { text: '💬 回复', callback_data: `setchat_${userId}` },
              { text: '📝 备注', callback_data: `qnote_${userId}` },
              { text: '🚫 拉黑', callback_data: `qban_${userId}` }
            ]]
          };

          for (const admin of ADMIN_IDS) {
             if (msg.text) {
               await tgReq('sendMessage', { 
                 chat_id: admin, 
                 text: `💬 **来自 👤 ${display}** (\`${userId}\`)\n\n${msg.text}`, 
                 parse_mode: 'Markdown', reply_markup: adminQuickActions 
               });
             } else {
               await tgReq('sendMessage', { 
                 chat_id: admin, 
                 text: `📎 **来自 👤 ${display}** (\`${userId}\`) 发送了 **${mediaDesc}**：`, 
                 parse_mode: 'Markdown', reply_markup: adminQuickActions 
               });
               await tgReq('forwardMessage', { chat_id: admin, from_chat_id: userId, message_id: msgId });
             }
          }
        } else {
          // 未验证：下发验证码
          ctx.waitUntil(incStat('blocked'));
          ctx.waitUntil(addBlockLog(userId, userName, '未验证拦截', msg.text || `[${mediaDesc || '媒体'}]`));

          const customWelcome = await env.KV.get('welcome_msg') || (isZh ? '您好！为了防止垃圾信息，请完成简单验证：' : 'Hi! To prevent spam, please verify:');
          
          const captchaTypeSetting = await env.KV.get('sys_captcha_type') || 'random';
          const types = ['fruit', 'math', 'find'];
          const cType = captchaTypeSetting === 'random' ? types[Math.floor(Math.random() * types.length)] : captchaTypeSetting;

          let qText = '';
          let correctAns = '';
          let wrong1 = '';
          let wrong2 = '';

          if (cType === 'math') {
             // 1. 两位数加减法
             const isAdd = Math.random() > 0.5;
             const a = Math.floor(Math.random() * 20) + 1;
             const b = Math.floor(Math.random() * 20) + 1;
             if (isAdd) {
                 correctAns = (a + b).toString();
                 qText = `**${a} + ${b} = ?**`;
             } else {
                 const max = Math.max(a, b) + 5; // 防止结果出现0或负数
                 const min = Math.min(a, b);
                 correctAns = (max - min).toString();
                 qText = `**${max} - ${min} = ?**`;
             }
             wrong1 = (parseInt(correctAns) + Math.floor(Math.random() * 5) + 1).toString();
             wrong2 = (parseInt(correctAns) - Math.floor(Math.random() * 5) - 1).toString();
          } else if (cType === 'find') {
             // 2. 找指定表情
             const emojis = ['🚗', '🍎', '🏠', '🐶', '💻', '⚽', '🎸', '⌚', '✈️', '🚲'];
             const target = emojis[Math.floor(Math.random() * emojis.length)];
             let others = emojis.filter(e => e !== target).sort(() => 0.5 - Math.random());
             correctAns = target;
             wrong1 = others[0];
             wrong2 = others[1];
             qText = `请在下方按钮中选出：**${target}**`;
          } else {
             // 3. 默认：数水果
             const fruitList = ['🍎', '🍐', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓'];
             const emojiA = fruitList[Math.floor(Math.random() * fruitList.length)];
             let emojiB = fruitList[Math.floor(Math.random() * fruitList.length)];
             while (emojiA === emojiB) emojiB = fruitList[Math.floor(Math.random() * fruitList.length)];

             const a = Math.floor(Math.random() * 5) + 1;
             const b = Math.floor(Math.random() * 5) + 1;
             correctAns = (a + b).toString();
             
             wrong1 = (parseInt(correctAns) + Math.floor(Math.random() * 3) + 1).toString();
             wrong2 = (parseInt(correctAns) - Math.floor(Math.random() * 3) - 1).toString();
             if (parseInt(wrong2) <= 0) wrong2 = (parseInt(correctAns) + 4).toString();
             
             qText = `**${emojiA.repeat(a)} + ${emojiB.repeat(b)} = ?**\n\n*(${isZh ? '💡 提示：请数一数水果的总数' : '💡 Hint: Count total fruits'})*`;
          }
          
          const options = [
            { text: correctAns, callback_data: 'captcha_pass' },
            { text: wrong1, callback_data: 'captcha_fail' },
            { text: wrong2, callback_data: 'captcha_fail' }
          ].sort(() => Math.random() - 0.5);

          await tgReq('sendMessage', {
            chat_id: userId,
            text: `🤖 **${isZh ? '安全验证' : 'Anti-Spam Captcha'}**\n\n${customWelcome}\n\n${qText}`,
            parse_mode: 'Markdown',
            reply_to_message_id: msgId,
            reply_markup: { inline_keyboard: [options] }
          });
        }
      }

      return new Response('OK');
    }

    return new Response('Super Bot is running.');
  }
};
