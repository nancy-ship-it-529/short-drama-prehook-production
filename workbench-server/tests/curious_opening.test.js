const assert = require('node:assert/strict');
const { validateCuriousOpening } = require('../case-qa');

assert.deepEqual(validateCuriousOpening('前三秒钩子：0.00-3.00秒｜道具指甲片忽然脱落→掌心出现发光记号→主角抓起信封冲向门口'), []);
assert.notEqual(validateCuriousOpening('前三秒钩子：0.00-3.00秒｜悬疑→震惊→反转').length, 0);
assert.notEqual(validateCuriousOpening('第一镜先拍空房，主角三秒后才进门').length, 0);
console.log('猎奇前三秒脚本门禁通过');
