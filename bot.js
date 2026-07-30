require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const fs = require('fs');

const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = process.env.ADMIN_ID;             // آیدی عددی تلگرام خودت (فروشنده)
const WALLET_ADDRESS = process.env.WALLET_ADDRESS; // آدرس کیف پول USDT (شبکه TRC20)
const BASE_PRICE = parseFloat(process.env.PRICE || '50'); // قیمت پایه به دلار (USDT)
const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'; // آدرس قرارداد USDT در شبکه ترون
const ORDERS_FILE = './orders.json';

// ---------- ابزارهای ذخیره‌سازی سفارش‌ها ----------
function loadOrders() {
  if (!fs.existsSync(ORDERS_FILE)) return {};
  return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8'));
}
function saveOrders(orders) {
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
}

// هر سفارش یک مبلغ منحصربه‌فرد می‌گیرد (مثلاً 50.137 به‌جای 50) تا
// بشه فهمید کدوم مشتری واریز کرده، چون آدرس کیف پول برای همه یکیه.
function generateUniqueAmount(orders) {
  let amount;
  do {
    const cents = Math.floor(Math.random() * 900) + 100; // بین 100 تا 999
    amount = (BASE_PRICE + cents / 1000).toFixed(3);
  } while (Object.values(orders).some((o) => o.amount === amount && o.status === 'pending'));
  return amount;
}

// ---------- دستورات ربات ----------
bot.start((ctx) => {
  ctx.reply(
    'سلام! به فروشگاه اکسپرت خوش اومدی 👋',
    Markup.inlineKeyboard([Markup.button.callback('🛒 خرید اکسپرت', 'buy')])
  );
});

bot.action('buy', async (ctx) => {
  const orders = loadOrders();
  const orderId = `${ctx.from.id}_${Date.now()}`;
  const amount = generateUniqueAmount(orders);

  orders[orderId] = {
    userId: ctx.from.id,
    username: ctx.from.username || ctx.from.first_name,
    amount,
    status: 'pending',
    createdAt: Date.now(),
  };
  saveOrders(orders);

  await ctx.answerCbQuery();
  await ctx.reply(
    'برای خرید اکسپرت، دقیقاً مبلغ زیر رو به آدرس کیف پول ارسال کن:\n\n' +
      `💰 مبلغ: ${amount} USDT (شبکه TRC20)\n` +
      `📥 آدرس: \`${WALLET_ADDRESS}\`\n\n` +
      '⚠️ توجه: مبلغ باید دقیقاً همین عدد باشه (تا سه رقم اعشار) تا پرداختت به‌صورت خودکار شناسایی بشه.\n\n' +
      'بعد از واریز روی دکمه زیر بزن:',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        Markup.button.callback('✅ پرداخت کردم، بررسی کن', `check_${orderId}`),
      ]),
    }
  );
});

bot.action(/check_(.+)/, async (ctx) => {
  const orderId = ctx.match[1];
  const orders = loadOrders();
  const order = orders[orderId];
  if (!order) return ctx.answerCbQuery('سفارش پیدا نشد');
  if (order.status === 'paid') return ctx.answerCbQuery('این سفارش قبلاً تایید شده ✅');

  await ctx.answerCbQuery('در حال بررسی تراکنش‌ها...');
  const paid = await checkPayment(order.amount);

  if (paid) {
    order.status = 'paid';
    orders[orderId] = order;
    saveOrders(orders);
    await ctx.reply('✅ پرداخت شما تایید شد! به‌زودی فایل اکسپرت رو براتون ارسال می‌کنیم.');
    await bot.telegram.sendMessage(
      ADMIN_ID,
      '💰 پرداخت جدید تایید شد:\n' +
        `کاربر: @${order.username} (ID: ${order.userId})\n` +
        `مبلغ: ${order.amount} USDT\n\n` +
        'لطفاً فایل اکسپرت رو براش ارسال کن.'
    );
  } else {
    await ctx.reply(
      'هنوز تراکنشی با این مبلغ پیدا نشد. چند دقیقه صبر کن و دوباره امتحان کن (تایید تراکنش شبکه ترون معمولاً ۱ تا ۲ دقیقه طول می‌کشه).'
    );
  }
});

// ---------- بررسی بلاکچین (شبکه ترون - TRC20) ----------
async function checkPayment(expectedAmount) {
  try {
    const url = `https://api.trongrid.io/v1/accounts/${WALLET_ADDRESS}/transactions/trc20`;
    const res = await axios.get(url, {
      params: { limit: 50, contract_address: USDT_CONTRACT, only_confirmed: true },
    });
    const txs = res.data.data || [];
    return txs.some((tx) => {
      const value = parseInt(tx.value, 10) / 1e6; // USDT شش رقم اعشار داره
      return Math.abs(value - parseFloat(expectedAmount)) < 0.0005 && tx.to === WALLET_ADDRESS;
    });
  } catch (err) {
    console.error('خطا در بررسی بلاکچین:', err.message);
    return false;
  }
}

bot.launch();
console.log('ربات روشن شد ✅');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
