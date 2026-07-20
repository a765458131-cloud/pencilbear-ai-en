import dotenv from 'dotenv';
dotenv.config();

type PayPalMode = 'sandbox' | 'live';

export const config = {
  port: parseInt(process.env.PORT || '3002', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  siteUrl: process.env.SITE_URL || 'http://localhost:3002',
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',
  dbPath: process.env.DB_PATH || 'data/app.db',
  paypal: {
    mode: (process.env.PAYPAL_MODE || 'sandbox') as PayPalMode,
    clientId: process.env.PAYPAL_CLIENT_ID || '',
    clientSecret: process.env.PAYPAL_CLIENT_SECRET || '',
    get base(): string {
      return this.mode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
    },
    get configured(): boolean {
      return !!this.clientId && !!this.clientSecret;
    },
  },
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT || '465', 10),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || 'PencilBear AI <no-reply@pencilbear.ai>',
    get configured(): boolean {
      return !!this.host && !!this.user && !!this.pass;
    },
  },
  alipay: {
    appId: process.env.ALIPAY_APP_ID || '',
    privateKey: (process.env.ALIPAY_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    alipayPublicKey: (process.env.ALIPAY_PUBLIC_KEY || '').replace(/\\n/g, '\n'),
    gateway: process.env.ALIPAY_GATEWAY || 'https://openapi.alipay.com/gateway.do',
    notifyUrl: process.env.ALIPAY_NOTIFY_URL || '',
    returnUrl: process.env.ALIPAY_RETURN_URL || '',
    get configured(): boolean {
      return !!this.appId && !!this.privateKey && !!this.alipayPublicKey;
    },
  },
  staticDir: process.env.STATIC_DIR || '',
  adminEmail: process.env.ADMIN_EMAIL || 'admin@pencilbear.ai',
  adminPassword: process.env.ADMIN_PASSWORD || 'a765458131',
};
