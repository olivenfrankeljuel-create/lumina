import { chromium } from 'playwright';
const b = await chromium.launch({ args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
const p = await b.newPage();
const r = await p.evaluate(()=>{ const c=document.createElement('canvas'); const gl=c.getContext('webgl2'); if(!gl) return 'no webgl2'; const d=gl.getExtension('WEBGL_debug_renderer_info'); return [gl.getParameter(d?d.UNMASKED_RENDERER_WEBGL:gl.RENDERER), gl.getParameter(gl.MAX_TEXTURE_SIZE), !!gl.getExtension('EXT_color_buffer_float')].join(' | ');});
console.log(r); await b.close();
