import { CSV_COLUMNS, csvCell, detectDelimiter, parseCsv, toCsv } from './products-csv.service.js';

describe('parseCsv', () => {
  it('đọc BOM, dấu ngoặc kép, xuống dòng trong ô và CRLF', () => {
    const text = '﻿name,price,description\r\n"Áo ""cotton""",199000,"dòng 1\nd dòng 2"\r\n,,\r\n';
    expect(parseCsv(text)).toEqual([
      ['name', 'price', 'description'],
      ['Áo "cotton"', '199000', 'dòng 1\nd dòng 2'],
    ]);
  });

  it('tự nhận dấu chấm phẩy', () => {
    expect(detectDelimiter('a;b;c')).toBe(';');
    expect(parseCsv('a;b\n1;2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
});

describe('csvCell / toCsv', () => {
  it('chống CSV injection và quote đúng', () => {
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell(null)).toBe('');
  });

  it('xuất có BOM và round-trip với parseCsv', () => {
    const rows = [
      ['name', 'price'],
      ['Áo, thun', 10],
    ];
    const out = toCsv(rows);
    expect(out.startsWith('﻿')).toBe(true);
    expect(parseCsv(out)).toEqual([
      ['name', 'price'],
      ['Áo, thun', '10'],
    ]);
  });
});

describe('CSV_COLUMNS', () => {
  it('có cột sản phẩm ảo / kho mã (is_virtual, code_delivery, code_warranty_days)', () => {
    expect(CSV_COLUMNS).toEqual(expect.arrayContaining(['isVirtual', 'codeDelivery', 'codeWarrantyDays']));
  });
});
