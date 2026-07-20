import { AlipaySdk } from 'alipay-sdk';
import { config } from './config.js';

let sdkCache: AlipaySdk | null = null;
let sdkInit = false;

function getSdk(): AlipaySdk | null {
  if (sdkInit) return sdkCache;
  sdkInit = true;
  if (!config.alipay.configured) return null;
  try {
    sdkCache = new AlipaySdk({
      appId: config.alipay.appId,
      privateKey: config.alipay.privateKey,
      alipayPublicKey: config.alipay.alipayPublicKey,
      gateway: config.alipay.gateway,
      signType: 'RSA2',
    });
    return sdkCache;
  } catch (e: any) {
    console.error('[alipay] SDK init failed:', e?.message || e);
    sdkCache = null;
    return null;
  }
}

export function alipayConfigured(): boolean {
  return config.alipay.configured;
}

/** 生成支付宝电脑网站支付跳转链接 */
export function createPagePayUrl(outTradeNo: string, amount: string, subject: string, body: string): string {
  const sdk = getSdk();
  if (!sdk) throw new Error('Alipay not configured');
  const url = sdk.pageExecute(
    'alipay.trade.page.pay',
    'GET',
    {
      bizContent: {
        out_trade_no: outTradeNo,
        product_code: 'FAST_INSTANT_TRADE_PAY',
        total_amount: amount,
        subject,
        body,
      },
      returnUrl: config.alipay.returnUrl || `${config.siteUrl}/?payment=success`,
      notifyUrl: config.alipay.notifyUrl,
    }
  );
  return url;
}

/** 查询支付宝订单状态，返回 TRADE_SUCCESS / TRADE_FINISHED / WAIT_BUYER_PAY 等 */
export async function queryOrder(outTradeNo: string): Promise<string> {
  const sdk = getSdk();
  if (!sdk) throw new Error('Alipay not configured');
  const r: any = await sdk.exec('alipay.trade.query', {
    bizContent: { out_trade_no: outTradeNo },
  });
  const resp = r?.alipay_trade_query_response;
  return resp?.trade_status || '';
}

/** 校验支付宝异步通知签名 */
export function verifyNotify(postData: Record<string, any>): boolean {
  const sdk = getSdk();
  if (!sdk) return false;
  try {
    return sdk.checkNotifySign(postData);
  } catch (e) {
    return false;
  }
}
