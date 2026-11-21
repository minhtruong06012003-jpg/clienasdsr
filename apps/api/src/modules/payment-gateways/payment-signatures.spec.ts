import { payosCreateSignature, payosDataSignature } from './payos.provider.js';
import { pay2sCreateSignature, pay2sIpnSignature } from './pay2s.provider.js';
import { hmacSha256 } from './payment-utils.js';

// Khoá & dữ liệu mẫu công khai trong tài liệu chính thức payOS (payos.vn/docs)
const PAYOS_CHECKSUM = '1a54716c8f0efb2744fb28b6e38b25da7f67a925d98bc1c18bd8faaecadd7675';

describe('PayOS signature', () => {
  it('chữ ký tạo link khớp ví dụ tài liệu', () => {
    expect(
      payosCreateSignature({ amount: 10000, cancelUrl: 'https://your-domain.com/cancel', description: 'DH123', orderCode: 123, returnUrl: 'https://your-domain.com/success' }, PAYOS_CHECKSUM),
    ).toBe('2fcf36e8f1380ef68cc943522692747adce72c930f99841b5c3163a899e6e86a');
  });

  it('chữ ký webhook khớp payload mẫu (null -> chuỗi rỗng, sắp xếp key)', () => {
    const data = {
      orderCode: 123,
      amount: 3000,
      description: 'VQRIO123',
      accountNumber: '12345678',
      reference: 'TF230204212323',
      transactionDateTime: '2023-02-04 18:25:00',
      currency: 'VND',
      paymentLinkId: '124c33293c43417ab7879e14c8d9eb18',
      code: '00',
      desc: 'Thành công',
      counterAccountBankId: '',
      counterAccountBankName: '',
      counterAccountName: null,
      counterAccountNumber: '',
      virtualAccountName: '',
      virtualAccountNumber: '',
    };
    expect(payosDataSignature(data, PAYOS_CHECKSUM)).toBe('412e915d2871504ed31be63c8f62a149a4410d34c4c42affc9006ef9917eaa03');
  });
});

describe('Pay2S signature', () => {
  it('chuỗi ký tạo thanh toán đúng thứ tự, bankAccounts=Array', () => {
    const p = { accessKey: 'AK', amount: 10000, ipnUrl: 'https://a/ipn', orderId: '1', orderInfo: 'DH123456789', partnerCode: 'PC', redirectUrl: 'https://a/r', requestId: 'r1', requestType: 'pay2s' };
    expect(pay2sCreateSignature(p, 'SK')).toBe(
      hmacSha256('SK', 'accessKey=AK&amount=10000&bankAccounts=Array&ipnUrl=https://a/ipn&orderId=1&orderInfo=DH123456789&partnerCode=PC&redirectUrl=https://a/r&requestId=r1&requestType=pay2s'),
    );
  });

  it('chuỗi ký IPN giữ field rỗng', () => {
    const d = { amount: 1000, message: 'OK', orderId: '1', orderInfo: 'X', orderType: 'pay2s', partnerCode: 'PC', payType: 'qr', requestId: 'r', responseTime: 123, resultCode: 0, transId: 9 };
    expect(pay2sIpnSignature(d, 'AK', 'SK')).toBe(
      hmacSha256('SK', 'accessKey=AK&amount=1000&extraData=&message=OK&orderId=1&orderInfo=X&orderType=pay2s&partnerCode=PC&payType=qr&requestId=r&responseTime=123&resultCode=0&transId=9'),
    );
  });
});
