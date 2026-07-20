import { config } from './config.js';

let cachedToken: { token: string; expires: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expires > Date.now() + 60000) return cachedToken.token;
  const auth = Buffer.from(`${config.paypal.clientId}:${config.paypal.clientSecret}`).toString('base64');
  const res = await fetch(`${config.paypal.base}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error('PayPal auth failed: ' + res.status);
  const data: any = await res.json();
  cachedToken = { token: data.access_token, expires: Date.now() + (data.expires_in || 300) * 1000 };
  return data.access_token;
}

export async function createOrder(
  amount: string,
  description: string,
  returnUrl: string,
  cancelUrl: string
): Promise<{ orderID: string; approveUrl: string }> {
  const token = await getAccessToken();
  const res = await fetch(`${config.paypal.base}/v2/checkout/orders`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [{ amount: { currency_code: 'USD', value: amount }, description }],
      application_context: {
        return_url: returnUrl,
        cancel_url: cancelUrl,
        user_action: 'PAY_NOW',
        brand_name: 'PencilBear AI',
      },
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error('PayPal createOrder failed: ' + res.status + ' ' + t);
  }
  const data: any = await res.json();
  const approve = (data.links || []).find((l: any) => l.rel === 'approve');
  return { orderID: data.id, approveUrl: approve ? approve.href : '' };
}

export async function getOrder(orderID: string): Promise<any> {
  const token = await getAccessToken();
  const res = await fetch(`${config.paypal.base}/v2/checkout/orders/${orderID}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error('PayPal getOrder failed: ' + res.status);
  return res.json();
}

export async function captureOrder(orderID: string): Promise<any> {
  const token = await getAccessToken();
  const res = await fetch(`${config.paypal.base}/v2/checkout/orders/${orderID}/capture`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error('PayPal capture failed: ' + res.status + ' ' + t);
  }
  return res.json();
}
