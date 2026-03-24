const DELIVERY_TYPES = ['local delivery', 'shipping'];
const DATE_RE = /^\d{2}-\d{2}-2026$/;

function validateOrder(order) {
  const rawTags = order.tags
    ? order.tags.split(',').map(t => t.trim()).filter(Boolean)
    : [];
  const issues = [];

  if (rawTags.length === 0) {
    issues.push({ type: 'danger', msg: 'No tags at all — missing delivery type and date' });
    return { issues, rawTags };
  }

  const deliveryTags = rawTags.filter(t => DELIVERY_TYPES.includes(t.toLowerCase()));
  const dateTags = rawTags.filter(t => /^\d{2}-\d{2}-\d{4}$/.test(t));

  if (deliveryTags.length === 0) {
    issues.push({ type: 'danger', msg: 'Missing delivery type (Local Delivery or Shipping)' });
  } else if (deliveryTags.length > 1) {
    issues.push({ type: 'warn', msg: 'Multiple delivery types: ' + deliveryTags.join(', ') });
  }

  if (dateTags.length === 0) {
    issues.push({ type: 'danger', msg: 'Missing date tag (expected MM-DD-2026)' });
  } else if (dateTags.length > 1) {
    issues.push({ type: 'warn', msg: 'Multiple date tags: ' + dateTags.join(', ') });
  } else {
    const d = dateTags[0];
    const parts = d.split('-');
    const month = parseInt(parts[0], 10);
    const day = parseInt(parts[1], 10);
    const year = parts[2];
    if (year !== '2026') issues.push({ type: 'danger', msg: 'Wrong year: ' + d + ' (must be 2026)' });
    if (month < 1 || month > 12) issues.push({ type: 'danger', msg: 'Invalid month: ' + d });
    if (day < 1 || day > 31) issues.push({ type: 'danger', msg: 'Invalid day: ' + d });
    if (parts[0].length !== 2 || parts[1].length !== 2) {
      issues.push({ type: 'warn', msg: 'Date not zero-padded: ' + d + ' (expected e.g. 03-03-2026)' });
    }
  }

  return { issues, rawTags };
}

export default async function handler(req, res) {
  // Allow manual triggers via GET, and Vercel cron via GET as well
  const shopUrl = process.env.SHOPIFY_STORE_URL?.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  const slackUrl = process.env.SLACK_WEBHOOK_URL;

  if (!shopUrl || !token || !slackUrl) {
    return res.status(500).json({ error: 'Missing environment variables' });
  }

  const since = new Date(Date.now() - 24 * 3600000).toISOString();

  try {
    const shopRes = await fetch(
      `https://${shopUrl}/admin/api/2024-01/orders.json?status=any&created_at_min=${since}&limit=250`,
      { headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' } }
    );

    if (!shopRes.ok) {
      throw new Error('Shopify API error: ' + shopRes.status);
    }

    const data = await shopRes.json();
    const orders = data.orders || [];
    const flagged = [];

    for (const order of orders) {
      const { issues, rawTags } = validateOrder(order);
      if (issues.length) flagged.push({ order, issues, rawTags });
    }

    if (flagged.length > 0) {
      const lines = flagged.map(({ order, issues }) =>
        '*Order #' + order.order_number + '* (' + (order.email || 'no email') + ')\n' +
        'Tags: ' + (order.tags || 'none') + '\n' +
        issues.map(i => (i.type === 'danger' ? '  :red_circle: ' : '  :warning: ') + i.msg).join('\n')
      ).join('\n\n');

      await fetch(slackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text:
            ':rotating_light: *Shopify tag check — ' + flagged.length + ' of ' + orders.length + ' orders flagged*\n\n' +
            lines +
            '\n\n_Checked at ' + new Date().toLocaleString() + '_'
        })
      });
    }

    return res.status(200).json({
      checked: orders.length,
      flagged: flagged.length,
      message: flagged.length === 0
        ? 'All orders passed validation'
        : flagged.length + ' orders flagged and Slack notified'
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
