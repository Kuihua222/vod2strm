// 文件：/api/[[path]].js - Vercel Serverless Function
// 这个文件处理所有后端请求：搜索、解析、生成STRM等。
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const axios = require('axios');

// 一个简单的内存存储（用于演示，生产环境应换为数据库）
const configStore = { vodApiUrl: 'http://caiji.dyttzyapi.com/api.php/provide/vod/' };
const strmStore = new Map();

export default async function handler(req, res) {
  const path = req.query.path?.[0] || '';

  // 1. 系统设置：获取或更新VOD资源站地址
  if (path === 'config' && req.method === 'GET') {
    return res.json({ vodApiUrl: configStore.vodApiUrl });
  }
  if (path === 'config' && req.method === 'POST') {
    configStore.vodApiUrl = req.body.vodApiUrl;
    return res.json({ success: true });
  }

  // 2. 搜索影视资源 (核心功能)
  if (path === 'search' && req.method === 'POST') {
    const { keyword, type } = req.body;
    try {
      const apiUrl = configStore.vodApiUrl;
      const response = await axios.get(apiUrl, { params: { ac: 'detail', wd: keyword } });
      
      const results = [];
      for (const item of response.data.list || []) {
        // 简单类型判断
        const isSeries = item.type_name === '电视剧' || item.vod_play_url.includes('#');
        if (type !== 'all' && ((type === 'movie' && isSeries) || (type === 'series' && !isSeries))) {
          continue;
        }

        // 解析播放地址
        const playSources = await parsePlayUrl(item.vod_play_url, item.vod_play_from);
        if (playSources.length > 0) {
          results.push({
            id: item.vod_id,
            name: item.vod_name,
            type: isSeries ? 'series' : 'movie',
            pic: item.vod_pic,
            year: item.vod_year,
            sources: playSources
          });
        }
      }
      res.json({ success: true, data: results });
    } catch (error) {
      res.json({ success: false, error: error.message });
    }
    return;
  }

  // 3. 生成并打包STRM文件 (核心功能)
  if (path === 'generate-strm' && req.method === 'POST') {
    const { resourceName, resourceType, playUrl, year } = req.body;
    
    // 生成符合Emby规范的目录和文件名
    const safeName = resourceName.replace(/[<>:"/\\|?*]/g, '');
    const baseFolder = year ? `${safeName} (${year})` : safeName;
    
    // 创建虚拟的文件结构
    const files = [];
    if (resourceType === 'movie') {
      // 电影：{电影名 (年份)}/{电影名 (年份)}.strm
      files.push({
        path: `${baseFolder}/${safeName}${year ? ` (${year})` : ''}.strm`,
        content: playUrl
      });
    } else {
      // 剧集：{剧集名 (年份)}/Season 01/S01E01.strm
      // 注意：这里简化处理，实际应根据解析出的剧集列表生成多个文件
      files.push({
        path: `${baseFolder}/Season 01/S01E01.strm`,
        content: playUrl
      });
    }
    
    // 保存记录
    const recordId = Date.now().toString();
    strmStore.set(recordId, {
      id: recordId,
      name: resourceName,
      type: resourceType,
      url: playUrl,
      generatedAt: new Date().toISOString(),
      files: files
    });
    
    // 返回记录ID，供前端下载和管理
    res.json({ success: true, recordId: recordId });
    return;
  }

  // 4. 下载STRM的ZIP包
  if (path === 'download-strm' && req.method === 'GET') {
    const { id } = req.query;
    const record = strmStore.get(id);
    if (!record) {
      return res.status(404).send('STRM记录不存在');
    }
    
    // 这里应生成ZIP文件，为简化，直接返回第一个STRM文件内容
    // 实际部署时，您需要安装`jszip`或`archiver`库来生成真正的ZIP
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${record.name}.strm"`);
    res.send(record.files[0].content);
    return;
  }

  // 5. 获取所有已生成的STRM记录
  if (path === 'my-strm' && req.method === 'GET') {
    const records = Array.from(strmStore.values()).reverse(); // 新的在前
    res.json({ success: true, data: records });
    return;
  }

  // 6. 查找最新可用源（重新解析）
  if (path === 'refresh-url' && req.method === 'POST') {
    const { id } = req.body;
    const record = strmStore.get(id);
    if (!record) {
      return res.json({ success: false, error: '记录不存在' });
    }
    
    // 这里应重新搜索并解析，示例中返回原地址
    res.json({ 
      success: true, 
      newUrl: record.url // 实际应返回新解析的地址
    });
  }

  res.status(404).json({ error: 'API路径不存在' });
}

// ---------- 核心工具函数 ----------
async function parsePlayUrl(playUrl, playFrom) {
  const sources = [];
  if (!playUrl) return sources;
  
  const sourceNames = (playFrom || '默认源').split('$$$');
  const urlGroups = playUrl.split('$$$');
  
  for (let i = 0; i < Math.min(urlGroups.length, sourceNames.length); i++) {
    const urls = urlGroups[i];
    const sourceName = sourceNames[i];
    
    // 分割剧集
    const episodes = urls.split('#');
    for (const ep of episodes) {
      if (!ep.includes('$')) continue;
      const [label, url] = ep.split('$');
      const cleanUrl = url?.trim();
      if (cleanUrl) {
        // 简单校验（实际应更完善）
        const isValid = await validateUrl(cleanUrl);
        if (isValid) {
          sources.push({
            source: sourceName,
            label: label || '播放',
            url: cleanUrl,
            isDirect: !cleanUrl.includes('url.cn') // 简单判断短链
          });
        }
      }
    }
  }
  
  // 优先返回直链源
  return sources.sort((a, b) => (b.isDirect ? 1 : 0) - (a.isDirect ? 1 : 0));
}

async function validateUrl(url) {
  try {
    // 发送HEAD请求检查URL是否可访问
    const resp = await axios.head(url, { timeout: 3000 });
    return resp.status < 400;
  } catch (e) {
    // 如果HEAD失败，尝试GET（针对某些限制HEAD的服务器）
    try {
      await axios.get(url, { timeout: 3000 });
      return true;
    } catch (e2) {
      return false;
    }
  }
}
