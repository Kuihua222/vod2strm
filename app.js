/**
 * VOD to Emby STRM Generator (Cloud/Vercel Version)
 * 模式：云端解析 -> 打包ZIP -> 客户端下载
 */

const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const cors = require('cors');
const AdmZip = require('adm-zip'); // 新增：用于打包下载
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// === 内存数据 (Vercel 重启后会重置，云端无法持久化本地JSON) ===
let MEMORY_DB = {
    vodApi: "https://cj.lziapi.com/api.php/provide/vod/at/json/",
    strmRecords: []
};

app.use(cors());
app.use(bodyParser.json());

// === 后端 API 逻辑 ===

// 1. 获取配置
app.get('/api/config', (req, res) => {
    res.json(MEMORY_DB);
});

// 2. 更新配置 (仅当前会话有效)
app.post('/api/config', (req, res) => {
    const { vodApi } = req.body;
    if (vodApi) MEMORY_DB.vodApi = vodApi;
    res.json({ success: true, message: "配置已更新 (云端重启后会重置)" });
});

// 3. 代理 VOD 请求
app.get('/api/proxy/vod', async (req, res) => {
    try {
        const { t, wd, ac, pg } = req.query;
        const params = { ac: ac || 'list', pg: pg || 1 };
        if (t) params.t = t;
        if (wd) params.wd = wd;

        const response = await axios.get(MEMORY_DB.vodApi, { params, timeout: 10000 });
        res.json(response.data);
    } catch (error) {
        console.error("VOD API Error:", error.message);
        res.status(500).json({ error: "无法连接资源站" });
    }
});

// 4. 解析短链/验证链接
async function resolveUrl(url) {
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    };
    try {
        if (url.includes('.m3u8') || url.includes('.mp4')) {
            // Vercel 有执行时间限制，这里为了速度跳过 HEAD 请求，直接信任直链
            // 如果需要严格验证，可以保留 await axios.head...
            return url;
        }
        const response = await axios.get(url, { 
            headers, 
            maxRedirects: 3,
            validateStatus: status => status < 400 
        });
        return response.request.res.responseUrl || url; 
    } catch (e) {
        return null;
    }
}

// 5. 生成并下载 ZIP (核心修改)
app.post('/api/generate-zip', async (req, res) => {
    const { vodName, vodYear, type, episodes, sourceName } = req.body;
    
    // 创建 ZIP 对象
    const zip = new AdmZip();
    const safeName = vodName.replace(/[\\/:*?"<>|]/g, "").trim();
    const yearStr = vodYear ? `(${vodYear})` : "";
    const folderName = `${safeName} ${yearStr}`.trim();

    try {
        if (type === 'movie') {
            // 电影路径结构
            const url = episodes[0]?.url;
            if (!url) throw new Error("无有效地址");
            const finalUrl = await resolveUrl(url);
            
            if (finalUrl) {
                // 向 zip 添加文件: movies/Name (Year)/Name (Year).strm
                const filePath = `movies/${folderName}/${folderName}.strm`;
                zip.addFile(filePath, Buffer.from(finalUrl, "utf8"));
            }
        } else {
            // 剧集路径结构
            let successCount = 0;
            // 限制并发解析数量，防止 Vercel 超时
            const processEpisodes = episodes.slice(0, 50); // 限制最多处理前50集防止超时

            for (let ep of processEpisodes) {
                let epNum = 1;
                const match = ep.name.match(/\d+/);
                if (match) epNum = parseInt(match[0]);
                const s01eXX = `S01E${epNum.toString().padStart(2, '0')}`;
                const strmName = `${safeName} - ${s01eXX} - ${ep.name}.strm`;
                
                let finalUrl = ep.url;
                if (!finalUrl.includes('.m3u8')) finalUrl = await resolveUrl(ep.url);

                if (finalUrl) {
                    // 向 zip 添加文件: shows/Name (Year)/Season 1/Name.strm
                    const filePath = `shows/${folderName}/Season 1/${strmName}`;
                    zip.addFile(filePath, Buffer.from(finalUrl, "utf8"));
                    successCount++;
                }
            }
            if (successCount === 0) throw new Error("解析失败");
        }

        // 记录历史 (仅内存)
        MEMORY_DB.strmRecords.unshift({
            id: Date.now(),
            name: safeName,
            type: type,
            source: sourceName,
            updatedAt: new Date().toLocaleString()
        });

        // 返回 ZIP 文件流
        const downloadName = `${safeName}_Emby_STRM.zip`;
        const data = zip.toBuffer();
        
        res.set('Content-Type', 'application/octet-stream');
        res.set('Content-Disposition', `attachment; filename=${encodeURIComponent(downloadName)}`);
        res.set('Content-Length', data.length);
        res.send(data);

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/records', (req, res) => res.json(MEMORY_DB.strmRecords));

// === 前端页面 ===
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>VOD 云端生成器</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://unpkg.com/vue@3/dist/vue.global.js"></script>
    <script src="https://unpkg.com/axios/dist/axios.min.js"></script>
    <style>[v-cloak] { display: none; } .poster-ratio { aspect-ratio: 2/3; }</style>
</head>
<body class="bg-gray-900 text-gray-100 font-sans min-h-screen">
<div id="app" v-cloak class="container mx-auto px-4 py-6">
    <header class="flex justify-between items-center mb-8 border-b border-gray-700 pb-4">
        <h1 class="text-2xl font-bold text-green-400">☁️ VOD to Emby (云端版)</h1>
        <div class="text-xs text-yellow-500">注意：Vercel 部署模式下数据无法永久保存</div>
    </header>

    <div class="flex gap-4 mb-6">
        <input v-model="searchQuery" @keyup.enter="fetchVod(1)" type="text" placeholder="搜索影片..." class="flex-1 bg-gray-800 border border-gray-700 rounded px-4 py-2 focus:outline-none focus:border-green-500">
        <button @click="fetchVod(1)" class="bg-green-600 hover:bg-green-500 text-white px-6 py-2 rounded">搜索</button>
    </div>

    <div v-if="loading" class="text-center py-20 text-gray-500">加载中...</div>
    <div v-else class="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-6">
        <div v-for="item in vodList" :key="item.vod_id" class="group relative bg-gray-800 rounded-lg overflow-hidden hover:scale-105 transition-transform duration-200 cursor-pointer" @click="openDetail(item)">
            <div class="poster-ratio w-full bg-gray-700 relative">
                <img :src="item.vod_pic" class="w-full h-full object-cover" loading="lazy" @error="$event.target.src='https://via.placeholder.com/300x450'">
                <div class="absolute top-1 right-1 bg-black/60 text-xs px-2 py-1 rounded text-white">{{ item.vod_remarks }}</div>
            </div>
            <div class="p-3"><h3 class="font-bold text-sm truncate">{{ item.vod_name }}</h3></div>
        </div>
    </div>

    <div v-if="showModal && selectedItem" class="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
        <div class="bg-gray-800 rounded-lg max-w-2xl w-full p-6">
            <h2 class="text-xl font-bold mb-4">{{ selectedItem.vod_name }}</h2>
            
            <div class="mb-4">
                <label class="block text-xs font-bold text-gray-500 mb-2">选择源</label>
                <div class="flex flex-wrap gap-2">
                    <button v-for="(source, index) in parseSources(selectedItem)" :key="index" @click="currentSourceIndex = index"
                            :class="currentSourceIndex === index ? 'bg-green-600 text-white' : 'bg-gray-700 text-gray-300'"
                            class="px-3 py-1 rounded text-sm">{{ source.name }}</button>
                </div>
            </div>

            <div class="bg-gray-900 p-4 h-40 overflow-y-auto mb-6 rounded border border-gray-700 text-xs text-gray-400">
                包含 {{ currentEpisodes.length }} 个资源文件
            </div>

            <div class="flex gap-4">
                <button @click="showModal = false" class="px-6 py-3 bg-gray-700 rounded text-white">关闭</button>
                <button @click="downloadZip" :disabled="processing" class="flex-1 bg-green-600 hover:bg-green-500 text-white py-3 rounded font-bold flex justify-center items-center">
                    <span v-if="processing">打包下载中...</span>
                    <span v-else>📥 下载 STRM 压缩包</span>
                </button>
            </div>
            <p class="text-xs text-gray-500 mt-2 text-center">下载后请解压到 Emby 媒体库目录</p>
        </div>
    </div>
</div>

<script>
const { createApp, ref, computed, onMounted } = Vue;
createApp({
    setup() {
        const loading = ref(false);
        const processing = ref(false);
        const vodList = ref([]);
        const searchQuery = ref('');
        const showModal = ref(false);
        const selectedItem = ref(null);
        const currentSourceIndex = ref(0);
        const config = ref({});

        onMounted(async () => {
             const res = await axios.get('/api/config');
             config.value = res.data;
             fetchVod(1);
        });

        const fetchVod = async (page) => {
            loading.value = true;
            try {
                const res = await axios.get('/api/proxy/vod', { params: { pg: page, wd: searchQuery.value } });
                vodList.value = res.data.list || [];
            } finally { loading.value = false; }
        };

        const parseSources = (item) => {
            if (!item) return [];
            return item.vod_play_from.split('$$$').map((name, i) => ({ name, urlStr: item.vod_play_url.split('$$$')[i] }));
        };

        const currentEpisodes = computed(() => {
            if (!selectedItem.value) return [];
            const src = parseSources(selectedItem.value)[currentSourceIndex.value];
            if (!src) return [];
            return src.urlStr.split('#').map(ep => {
                const [n, u] = ep.split('$');
                return { name: n||'正片', url: u||n };
            }).filter(e=>e.url);
        });

        const openDetail = (item) => {
            selectedItem.value = item;
            currentSourceIndex.value = 0;
            showModal.value = true;
        };

        const downloadZip = async () => {
            processing.value = true;
            try {
                const isMovie = selectedItem.value.type_id == 1;
                const payload = {
                    vodName: selectedItem.value.vod_name,
                    vodYear: selectedItem.value.vod_year,
                    type: isMovie ? 'movie' : 'tv',
                    episodes: currentEpisodes.value,
                    sourceName: parseSources(selectedItem.value)[currentSourceIndex.value].name
                };

                const response = await axios.post('/api/generate-zip', payload, { responseType: 'blob' });
                // 触发浏览器下载
                const url = window.URL.createObjectURL(new Blob([response.data]));
                const link = document.createElement('a');
                link.href = url;
                link.setAttribute('download', \`\${selectedItem.value.vod_name}_Emby.zip\`);
                document.body.appendChild(link);
                link.click();
                link.remove();
                showModal.value = false;
            } catch (e) {
                alert('打包失败，可能是源地址无法连接');
            } finally {
                processing.value = false;
            }
        };

        return { loading, processing, vodList, searchQuery, showModal, selectedItem, currentSourceIndex, fetchVod, parseSources, currentEpisodes, openDetail, downloadZip };
    }
}).mount('#app');
</script>
</body>
</html>
    `);
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
