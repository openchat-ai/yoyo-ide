const fs = require('fs');
const origWrite = fs.writeFileSync;
let capturedContent = null;
fs.writeFileSync = function(p, content) {
    if (p.endsWith('yoyo.ty') || p.endsWith('yoyol.ty')) {
        capturedContent = content;
    } else {
        return origWrite.call(this, p, content);
    }
};

process.argv = ['node', 'yoyo-gen.js', '--target=linux'];
const origCwd = process.cwd();
process.chdir('F:/yoyo-ide');
require('F:/yoyo-ide/src/yoyo-gen.js');

fs.writeFileSync = origWrite;
if (capturedContent) {
    const checks = [
        '48 bf 00 00 00 00 00 00 00 00',
        'genLinuxAllocHandler',
        'genLinuxLoadFileHandler',
        'genLinuxWriteFileHandler',
        '30 45 48',
        '48 bf',
    ];
    for (const s of checks) {
        const idx = capturedContent.indexOf(s);
        console.log((idx >= 0 ? 'FOUND' : 'NOT FOUND') + ': ' + JSON.stringify(s) + ' at ' + (idx >= 0 ? idx : 'N/A'));
    }
    console.log('\nTotal length:', capturedContent.length);
    console.log('Line count:', capturedContent.split('\n').length);
}
