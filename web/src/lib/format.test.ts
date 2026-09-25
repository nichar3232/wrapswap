import {it,expect} from 'vitest';import {amount,short,parityOutput} from './format';
it('formats raw amounts without changing units',()=>{expect(amount('123456789',6,4)).toBe('123.4567');expect(amount(undefined)).toBe('—');expect(amount('1000000000000000000')).toBe('1');expect(short('0x1234567890abcdef')).toBe('0x1234…cdef')});
it('quotes equal shares across 8 and 18 decimal wrappers',()=>expect(parityOutput(10n**8n,2n*10n**18n,10n**18n,8,18)).toBe(2n*10n**18n));
