import {spawn} from 'node:child_process';
const server=spawn(process.execPath,['server/index.js'],{stdio:'inherit'});
const frontend=spawn(process.execPath,['node_modules/vite/bin/vite.js','--config','vite.config.js'],{stdio:'inherit'});
let closing=false;
function close(code=0){if(closing)return;closing=true;server.kill();frontend.kill();setTimeout(()=>process.exit(code),100).unref();}
server.on('exit',code=>close(code||0));frontend.on('exit',code=>close(code||0));
process.on('SIGINT',()=>close());process.on('SIGTERM',()=>close());
