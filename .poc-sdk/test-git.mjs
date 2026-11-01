import * as g from '../packages/dsh-plugin-qoder/lib/git-tools.js';

const cwd = 'D:/code/dsh-plugins/.poc-sdk/fake-repo';
const status = await g.status(cwd);
console.log('status.isRepo =', status.isRepo);
console.log('status.clean  =', status.clean);
console.log('status.entries=', JSON.stringify(status.entries));

const head = await g.head(cwd);
console.log('head =', JSON.stringify(head));

const d = await g.diff(cwd);
console.log('diff.isRepo   =', d.isRepo);
console.log('diff.files    =', JSON.stringify(d.files));
console.log('diff.untracked=', JSON.stringify(d.untracked));
console.log('diff.patch    =');
console.log(d.patch.split('\n').slice(0, 20).join('\n'));
