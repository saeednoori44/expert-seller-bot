require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const fs = require('fs');
const { SocksProxyAgent } = require('socks-proxy-agent');

// اگه PROXY_URL توی .env تنظیم شده باشه (مثلاً چون تلگرام از این سرور فیلتره)،
// همه‌ی درخواست‌ها (هم به تلگرام، هم به بلاکچین) از همین پروکسی محلی رد می‌شن.
const PROXY_URL = process.env.PROXY_URL || '';
const proxyAgent = PROXY_URL ? new SocksProxyAgent(PROXY_URL) : null;

const bot = new Telegraf(process.env.BOT_TOKEN, {
  telegram: proxyAgent ? { agent: proxyAgent } : {},
});
const ADMIN_ID = process.env.ADMIN_ID;             // آیدی عددی تلگرام خودت (فروشنده)
const WALLET_ADDRESS = process.env.WALLET_ADDRESS; // آدرس کیف پول USDT (شبکه TRC20)
const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'; // آدرس قرارداد USDT در شبکه ترون
const ORDERS_FILE = './orders.json';
// حالت تست: اگه TEST_MODE=true باشه، ربات بدون چک واقعی بلاکچین همه‌ی پرداخت‌ها رو
// «تایید‌شده» در نظر می‌گیره تا بتونی بدون واریز واقعی، بقیه مراحل رو امتحان کنی.
const TEST_MODE = process.env.TEST_MODE === 'true';

// کانالی که مشتری باید عضوش باشه (یوزرنیم پابلیک، با @ شروع می‌شه)
const CHANNEL_USERNAME = process.env.CHANNEL_USERNAME || '';
// لینک عضویت که به مشتری نشون داده می‌شه (اگه خالی بود، خودش از یوزرنیم می‌سازتش)
const CHANNEL_LINK = process.env.CHANNEL_LINK || (CHANNEL_USERNAME ? `https://t.me/${CHANNEL_USERNAME.replace('@', '')}` : '');

// ---------- پلن‌های فروش (مدت و قیمت) ----------
const PLANS = [
  { code: '1m', label: '۱ ماهه', price: parseFloat(process.env.PRICE_1M || '100') },
  { code: '3m', label: '۳ ماهه', price: parseFloat(process.env.PRICE_3M || '230') },
  { code: '6m', label: '۶ ماهه', price: parseFloat(process.env.PRICE_6M || '500') },
  { code: '1y', label: '۱ ساله', price: parseFloat(process.env.PRICE_1Y || '800') },
];

// ---------- ابزارهای ذخیره‌سازی سفارش‌ها ----------
function loadOrders() {
  if (!fs.existsSync(ORDERS_FILE)) return {};
  return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8'));
}
function saveOrders(orders) {
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
}

// هر سفارش یک مبلغ منحصربه‌فرد می‌گیرد (مثلاً 100.137 به‌جای 100) تا
// بشه فهمید کدوم مشتری واریز کرده، چون آدرس کیف پول برای همه یکیه.
function generateUniqueAmount(orders, basePrice) {
  let amount;
  do {
    const cents = Math.floor(Math.random() * 900) + 100; // بین 100 تا 999
    amount = (basePrice + cents / 1000).toFixed(3);
  } while (Object.values(orders).some((o) => o.amount === amount && o.status === 'pending'));
  return amount;
}

// ---------- بررسی عضویت مشتری توی کانال ----------
async function isChannelMember(userId) {
  if (!CHANNEL_USERNAME) return true; // اگه کانال تنظیم نشده، این چک رو رد کن
  try {
    const member = await bot.telegram.getChatMember(CHANNEL_USERNAME, userId);
    return ['member', 'administrator', 'creator'].includes(member.status);
  } catch (err) {
    console.error('خطا در بررسی عضویت کانال:', err.message);
    return false;
  }
}

// پیام خوش‌آمد + دکمه خرید (بعد از تایید عضویت کانال نشون داده می‌شه)
async function showWelcome(ctx) {
  await ctx.reply(
    'سلام! به فروشگاه اکسپرت خوش اومدی 👋',
    Markup.inlineKeyboard([Markup.button.callback('🛒 خرید اکسپرت', 'buy')])
  );
}

// پیام «باید عضو کانال بشی» + دکمه‌های عضویت و بررسی مجدد
async function showJoinChannelPrompt(ctx) {
  await ctx.reply(
    '⚠️ برای خرید اکسپرت، اول باید عضو کانال ما بشی.\n\n' +
      'روی دکمه «عضویت در کانال» بزن، عضو شو، بعد برگرد و «بررسی مجدد» رو بزن:',
    Markup.inlineKeyboard([
      [Markup.button.url('📢 عضویت در کانال', CHANNEL_LINK)],
      [Markup.button.callback('🔄 بررسی مجدد عضویت', 'check_membership')],
    ])
  );
}

// ---------- دستورات ربات ----------
bot.start(async (ctx) => {
  const member = await isChannelMember(ctx.from.id);
  if (member) {
    await showWelcome(ctx);
  } else {
    await showJoinChannelPrompt(ctx);
  }
});

bot.action('check_membership', async (ctx) => {
  const member = await isChannelMember(ctx.from.id);
  await ctx.answerCbQuery();
  if (member) {
    await ctx.reply('عضویتت تایید شد ✅');
    await showWelcome(ctx);
  } else {
    await ctx.reply('هنوز عضو کانال نشدی. لطفاً اول عضو شو، بعد دوباره بررسی مجدد رو بزن.');
  }
});

bot.action('buy', async (ctx) => {
  const member = await isChannelMember(ctx.from.id);
  if (!member) {
    await ctx.answerCbQuery();
    return showJoinChannelPrompt(ctx);
  }

  await ctx.answerCbQuery();
  await ctx.reply(
    'اکسپرت رو برای چه مدتی می‌خوای؟',
    Markup.inlineKeyboard(
      PLANS.map((p) => [Markup.button.callback(`${p.label} - ${p.price}$`, `plan_${p.code}`)])
    )
  );
});

bot.action(/plan_(1m|3m|6m|1y)/, async (ctx) => {
  const plan = PLANS.find((p) => p.code === ctx.match[1]);
  if (!plan) return ctx.answerCbQuery('پلن پیدا نشد');

  const orders = loadOrders();
  const orderId = `${ctx.from.id}_${Date.now()}`;
  const amount = generateUniqueAmount(orders, plan.price);

  orders[orderId] = {
    userId: ctx.from.id,
    username: ctx.from.username || ctx.from.first_name,
    planLabel: plan.label,
    planPrice: plan.price,
    amount,
    status: 'pending',
    createdAt: Date.now(),
  };
  saveOrders(orders);

  await ctx.answerCbQuery();
  await ctx.reply(
    `پلن انتخابی: ${plan.label} (${plan.price}$)\n\n` +
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
    order.awaitingPlatform = true; // منتظر انتخاب نسخه متاتریدر
    orders[orderId] = order;
    saveOrders(orders);
    await ctx.reply(
      '✅ پرداخت شما تایید شد!\n\n' + 'اکسپرت رو برای کدوم نسخه متاتریدر لازم داری؟',
      Markup.inlineKeyboard([
        [Markup.button.callback('MetaTrader 4', `platform_mt4_${orderId}`)],
        [Markup.button.callback('MetaTrader 5', `platform_mt5_${orderId}`)],
      ])
    );
  } else {
    await ctx.reply(
      'هنوز تراکنشی با این مبلغ پیدا نشد. چند دقیقه صبر کن و دوباره امتحان کن (تایید تراکنش شبکه ترون معمولاً ۱ تا ۲ دقیقه طول می‌کشه).\n\n' +
        'اگه مطمئنی پول رو فرستادی ولی باز پیدا نشد (مثلاً مبلغ رو دقیق وارد نکردی)، می‌تونی به‌جای اون، هش تراکنش رو برام بفرستی:',
      Markup.inlineKeyboard([
        Markup.button.callback('🔎 فرستادن هش تراکنش', `hash_${orderId}`),
      ])
    );
  }
});

// ---------- دکمه‌ی «فرستادن هش تراکنش» (راه پشتیبان اگه مبلغ دقیق شناسایی نشد) ----------
bot.action(/hash_(.+)/, async (ctx) => {
  const orderId = ctx.match[1];
  const orders = loadOrders();
  const order = orders[orderId];
  if (!order) return ctx.answerCbQuery('سفارش پیدا نشد');
  if (order.status === 'paid') return ctx.answerCbQuery('این سفارش قبلاً تایید شده ✅');

  order.awaitingHash = true;
  orders[orderId] = order;
  saveOrders(orders);

  await ctx.answerCbQuery();
  await ctx.reply(
    'باشه، هش (Transaction Hash / TXID) تراکنشی که فرستادی رو همینجا برام بفرست.\n' +
      'این یه رشته طولانی حروف و عدده که توی کیف پول یا صرافیت، کنار تراکنش انجام‌شده نشون داده می‌شه.'
  );
});

// ---------- انتخاب نسخه متاتریدر (MT4 یا MT5) بعد از تایید پرداخت ----------
bot.action(/platform_(mt4|mt5)_(.+)/, async (ctx) => {
  const platform = ctx.match[1] === 'mt4' ? 'MetaTrader 4' : 'MetaTrader 5';
  const orderId = ctx.match[2];
  const orders = loadOrders();
  const order = orders[orderId];
  if (!order) return ctx.answerCbQuery('سفارش پیدا نشد');

  order.platform = platform;
  order.awaitingPlatform = false;
  order.awaitingAccount = true; // حالا نوبت شماره اکانته
  orders[orderId] = order;
  saveOrders(orders);

  await ctx.answerCbQuery();
  await ctx.reply(
    `باشه، نسخه ${platform} ثبت شد ✅\n\n` +
      'حالا لطفاً شماره اکانت متاتریدر خودت رو همینجا برام بفرست تا اکسپرت روی همون اکانت فعال بشه.'
  );
});

// ---------- دریافت پیام‌های متنی (هش تراکنش یا شماره اکانت متاتریدر) ----------
bot.on('text', async (ctx) => {
  const orders = loadOrders();
  const orderId = Object.keys(orders).find(
    (id) => orders[id].userId === ctx.from.id && (orders[id].awaitingHash || orders[id].awaitingAccount)
  );
  if (!orderId) return; // پیام معمولیه، ربطی به فرآیند خرید نداره

  const order = orders[orderId];

  // حالت اول: منتظر هش تراکنش هستیم
  if (order.awaitingHash) {
    const hash = ctx.message.text.trim();
    await ctx.reply('در حال بررسی این تراکنش روی بلاکچین... ⏳');
    const paid = await checkPaymentByHash(hash);

    if (paid) {
      order.status = 'paid';
      order.txHash = hash;
      order.awaitingHash = false;
      order.awaitingPlatform = true; // حالا نوبت انتخاب نسخه متاتریدره
      orders[orderId] = order;
      saveOrders(orders);
      await ctx.reply(
        '✅ این تراکنش تایید شد!\n\n' + 'اکسپرت رو برای کدوم نسخه متاتریدر لازم داری؟',
        Markup.inlineKeyboard([
          [Markup.button.callback('MetaTrader 4', `platform_mt4_${orderId}`)],
          [Markup.button.callback('MetaTrader 5', `platform_mt5_${orderId}`)],
        ])
      );
    } else {
      await ctx.reply(
        'این هش پیدا نشد یا با این کیف پول مطابقت نداشت. لطفاً هش رو دوباره چک کن و کامل بفرست، ' +
          'یا اگه مطمئنی درسته، می‌تونی مستقیم با ادمین در ارتباط باشی.'
      );
    }
    return;
  }

  // حالت دوم: منتظر شماره اکانت متاتریدر هستیم
  if (order.awaitingAccount) {
    order.accountNumber = ctx.message.text.trim();
    order.awaitingAccount = false;
    orders[orderId] = order;
    saveOrders(orders);

    await ctx.reply('دریافت شد ✅ به‌زودی اکسپرت روی همین اکانت براتون فعال می‌شه.');

    // اینجا خودت (ادمین) شماره اکانت خریدار رو می‌بینی
    await bot.telegram.sendMessage(
      ADMIN_ID,
      '🧾 شماره اکانت متاتریدر دریافت شد:\n' +
        `کاربر: @${order.username} (ID: ${order.userId})\n` +
        `پلن: ${order.planLabel || 'مشخص نشده'} (${order.planPrice || order.amount}$)\n` +
        `مبلغ پرداختی: ${order.amount} USDT\n` +
        (order.txHash ? `هش تراکنش (تایید دستی): ${order.txHash}\n` : '') +
        `نسخه متاتریدر: ${order.platform || 'مشخص نشده'}\n` +
        `شماره اکانت متاتریدر: ${order.accountNumber}\n\n` +
        'لطفاً فایل اکسپرت رو براش ارسال/فعال کن.'
    );
  }
});

// ---------- بررسی بلاکچین (شبکه ترون - TRC20) ----------
async function checkPayment(expectedAmount) {
  if (TEST_MODE) return true; // حالت تست: همیشه تایید کن، بدون چک واقعی
  try {
    const url = `https://api.trongrid.io/v1/accounts/${WALLET_ADDRESS}/transactions/trc20`;
    const res = await axios.get(url, {
      params: { limit: 50, contract_address: USDT_CONTRACT, only_confirmed: true },
      httpsAgent: proxyAgent || undefined,
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

// ---------- بررسی یک تراکنش خاص با هش (روش پشتیبان) ----------
async function checkPaymentByHash(hash) {
  try {
    // لیست آخرین انتقال‌های USDT به کیف پول رو می‌گیریم و دنبال همین هش می‌گردیم
    const url = `https://api.trongrid.io/v1/accounts/${WALLET_ADDRESS}/transactions/trc20`;
    const res = await axios.get(url, {
      params: { limit: 50, contract_address: USDT_CONTRACT, only_confirmed: true },
      httpsAgent: proxyAgent || undefined,
    });
    const txs = res.data.data || [];
    return txs.some(
      (tx) => tx.transaction_id === hash && tx.to === WALLET_ADDRESS
    );
  } catch (err) {
    console.error('خطا در بررسی هش تراکنش:', err.message);
    return false;
  }
}

bot.launch();
console.log('ربات روشن شد ✅');
if (TEST_MODE) console.log('⚠️ حالت تست فعاله: هر پرداختی خودکار تایید می‌شه (بدون چک واقعی بلاکچین)');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
