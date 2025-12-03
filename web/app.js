// 全局状态
let currentPage = 1;
let currentSource = 0;
let currentType = "all";
let selectedVod = null;
let batchSelection = [];
let searchDebounceTimer = null;

// ========== Tab 切换 ==========
function switchTab(tabId, btnEl) {
    // 更新导航按钮状态
    document.querySelectorAll(".menu-item").forEach(btn => {
        btn.classList.remove("active");
    });
    btnEl.classList.add("active");

    // 更新页面显示
    document.querySelectorAll(".tab-page").forEach(page => {
        page.classList.remove("active");
    });
    document.getElementById(`tab-${tabId}`).classList.add("active");

    // 加载对应页面数据
    if (tabId === "home") {
        document.getElementById("categoryBox").classList.remove("hidden");
        loadCategories();
        loadVodList();
    } else if (tabId === "mine") {
        document.getElementById("categoryBox").classList.add("hidden");
        loadMyStrm();
    } else if (tabId === "settings") {
        document.getElementById("categoryBox").classList.add("hidden");
        loadSettings();
    }
}

// ========== 分类加载 ==========
function loadCategories() {
    fetch(`/api/vod/categories?source_index=${currentSource}`)
        .then(res => res.json())
        .then(data => {
            if (data.ok) {
                const catList = document.getElementById("catList");
                catList.innerHTML = '<li class="cat-item active" onclick="changeCategory(\'all\', this)">全部</li>';
                data.class.forEach(cat => {
                    catList.innerHTML += `
                        <li class="cat-item" onclick="changeCategory('${cat.type_id}', this)">${cat.type_name}</li>
                    `;
                });
            }
        });
}

// 切换分类
function changeCategory(typeId, el) {
    document.querySelectorAll(".cat-item").forEach(item => item.classList.remove("active"));
    el.classList.add("active");
    currentType = typeId;
    currentPage = 1;
    loadVodList();
}

// ========== 资源源切换 ==========
function onSourceChange() {
    currentSource = parseInt(document.getElementById("sourceSelect").value);
    currentPage = 1;
    loadCategories();
    loadVodList();
}

// 加载资源源列表
function loadSourceOptions() {
    fetch("/api/config")
        .then(res => res.json())
        .then(config => {
            const select = document.getElementById("sourceSelect");
            select.innerHTML = "";
            config.sources.forEach((src, idx) => {
                select.innerHTML += `<option value="${idx}">源 ${idx + 1}: ${src.slice(0, 30)}...</option>`;
            });
            currentSource = 0;
        });
}

// ========== VOD列表加载 ==========
function loadVodList() {
    setStatus("加载中...");
    fetch(`/api/vod/list?source_index=${currentSource}&page=${currentPage}&type_id=${currentType}`)
        .then(res => res.json())
        .then(data => {
            if (data.ok && data.data) {
                const grid = document.getElementById("posterGrid");
                grid.innerHTML = "";
                data.data.list.forEach(item => {
                    const imgUrl = getProxyImageUrl(item.vod_pic);
                    grid.innerHTML += `
                        <div class="poster-card">
                            <input type="checkbox" onchange="toggleBatchSelection(this, ${JSON.stringify(item)})">
                            <img src="${imgUrl}" onerror="this.src='https://via.placeholder.com/160x220?text=无海报'">
                            <div class="poster-title">${item.vod_name}</div>
                            <div class="poster-badge">
                                <span>${item.vod_year || ""}</span>
                                <span>${item.type_name || ""}</span>
                            </div>
                        </div>
                    `;
                });
                // 更新分页
                document.getElementById("pageInfo").textContent = 
                    `${currentPage} / ${data.data.pagecount || 1}`;
                // 更新批量选择按钮
                updateBatchButton();
                setStatus(`加载完成 (${data.data.total || 0} 条)`);
            } else {
                setStatus("加载失败");
            }
        });
}

// 图片代理处理
function getProxyImageUrl(url) {
    if (!url) return "";
    // 检查是否需要使用代理
    const useProxy = localStorage.getItem("useImgProxy") === "true";
    return useProxy ? `/api/proxy/img?url=${encodeURIComponent(url)}` : url;
}

// 分页切换
function changePage(delta) {
    const newPage = currentPage + delta;
    if (newPage < 1) return;
    currentPage = newPage;
    loadVodList();
}

// ========== 搜索功能 ==========
function doSearchDebounced() {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(doSearch, 500);
}

function doSearch() {
    const keyword = document.getElementById("searchInput").value.trim();
    if (!keyword) {
        currentType = "all";
        loadVodList();
        return;
    }
    setStatus("搜索中...");
    fetch(`/api/vod/search?keyword=${encodeURIComponent(keyword)}`)
        .then(res => res.json())
        .then(data => {
            if (data.ok) {
                const grid = document.getElementById("posterGrid");
                grid.innerHTML = "";
                data.list.forEach(item => {
                    const imgUrl = getProxyImageUrl(item.vod_pic);
                    grid.innerHTML += `
                        <div class="poster-card" onclick="openVodDetail(${item._source_index}, '${item.vod_id}')">
                            <input type="checkbox" onchange="toggleBatchSelection(this, ${JSON.stringify(item)})">
                            <img src="${imgUrl}" onerror="this.src='https://via.placeholder.com/160x220?text=无海报'">
                            <div class="poster-title">${item.vod_name}</div>
                            <div class="poster-badge">
                                <span>源${item._source_index + 1}</span>
                                <span>${item.vod_year || ""}</span>
                            </div>
                        </div>
                    `;
                });
                setStatus(`搜索到 ${data.list.length} 条结果`);
            } else {
                setStatus("搜索失败");
            }
        });
}

// ========== 批量选择 ==========
function toggleBatchSelection(checkbox, item) {
    if (checkbox.checked) {
        batchSelection.push({
            vod_id: item.vod_id,
            vod_name: item.vod_name,
            vod_pic: item.vod_pic,
            vod_year: item.vod_year || "",
            type_name: item.type_name || "",
            source_index: item._source_index || currentSource,
            play_source_idx: 0
        });
    } else {
        batchSelection = batchSelection.filter(i => i.vod_id !== item.vod_id);
    }
    updateBatchButton();
}

function updateBatchButton() {
    const btn = document.getElementById("batchGenerateBtn");
    if (batchSelection.length > 0) {
        btn.textContent = `批量生成 (${batchSelection.length})`;
        btn.classList.remove("hidden");
    } else {
        btn.classList.add("hidden");
    }
}

// ========== 详情页处理 ==========
function openVodDetail(sourceIndex, vodId) {
    setStatus("加载详情...");
    fetch(`/api/vod/detail?source_index=${sourceIndex}&vod_id=${vodId}`)
        .then(res => res.json())
        .then(data => {
            if (data.ok) {
                selectedVod = { ...data.data, source_index: sourceIndex };
                // 填充详情数据
                document.getElementById("mPic").src = getProxyImageUrl(data.data.vod_pic);
                document.getElementById("mTitle").textContent = data.data.vod_name;
                document.getElementById("mYear").textContent = data.data.vod_year || "未知年份";
                document.getElementById("mType").textContent = data.data.type_name || "未知类型";
                document.getElementById("mArea").textContent = data.data.vod_area || "未知地区";
                document.getElementById("mDesc").textContent = data.data.vod_content || "暂无简介";
                
                // 填充播放源
                const sourceTabs = document.getElementById("sourceTabs");
                sourceTabs.innerHTML = "";
                data.play_sources.forEach((source, idx) => {
                    sourceTabs.innerHTML += `
                        <div class="source-tab ${idx === 0 ? 'active' : ''}" 
                             onclick="switchPlaySource(${idx}, '${encodeURIComponent(source.url_content)}')">
                            ${source.name}
                        </div>
                    `;
                });
                
                // 显示第一组集数
                if (data.play_sources.length > 0) {
                    switchPlaySource(0, encodeURIComponent(data.play_sources[0].url_content));
                }
                
                // 显示模态框
                document.getElementById("modal").classList.add("show");
                setStatus("详情加载完成");
            } else {
                setStatus("详情加载失败");
            }
        });
}

// 切换播放源
function switchPlaySource(idx, urlContent) {
    document.querySelectorAll(".source-tab").forEach(tab => tab.classList.remove("active"));
    document.querySelectorAll(".source-tab")[idx].classList.add("active");
    
    // 解析集数
    const decodedContent = decodeURIComponent(urlContent);
    const episodes = decodedContent.split("#");
    const fileList = document.getElementById("fileList");
    fileList.innerHTML = "";
    
    episodes.forEach((ep, epIdx) => {
        const parts = ep.split("$");
        const epName = parts[0];
        const epUrl = parts[1] || parts[0];
        fileList.innerHTML += `
            <div class="file-item" onclick="selectEpisode(this, '${epUrl}')">
                <span class="file-name">${epName}</span>
                <span>▶</span>
            </div>
        `;
    });
    
    // 更新集数统计
    document.getElementById("epCount").textContent = episodes.length;
    
    // 选中第一集
    if (fileList.firstChild) {
        selectEpisode(fileList.firstChild, episodes[0].split("$")[1] || episodes[0].split("$")[0]);
    }
    
    // 更新生成按钮事件
    document.getElementById("btnGenerate").onclick = () => {
        generateStrm({
            vod_id: selectedVod.vod_id,
            vod_name: selectedVod.vod_name,
            vod_pic: selectedVod.vod_pic,
            vod_year: selectedVod.vod_year || "",
            type_name: selectedVod.type_name || "",
            source_index: selectedVod.source_index,
            play_source_idx: idx,
            url_content: decodedContent
        });
    };
}

// 选择集数
function selectEpisode(el, url) {
    document.querySelectorAll(".file-item").forEach(item => item.classList.remove("selected"));
    el.classList.add("selected");
    // 更新预览按钮
    document.getElementById("btnPreview").onclick = () => {
        fetch("/api/config").then(res => res.json()).then(config => {
            const playerUrl = config.player_scheme + encodeURIComponent(url);
            window.open(playerUrl);
        });
    };
}

// 关闭模态框
function closeModal() {
    document.getElementById("modal").classList.remove("show");
}

// ========== 生成STRM ==========
function generateStrm(params) {
    const logEl = document.getElementById("genLog");
    logEl.textContent = "开始生成...\n";
    
    fetch("/api/generate/single", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params)
    }).then(res => res.json()).then(data => {
        if (data.logs) {
            data.logs.forEach(log => {
                logEl.textContent += log + "\n";
            });
        }
        if (data.ok) {
            logEl.textContent += "✅ 生成成功！\n";
            // 刷新媒体库列表
            loadMyStrm();
        } else {
            logEl.textContent += "❌ " + (data.msg || "生成失败") + "\n";
        }
    });
}

// ========== 批量生成 ==========
function openBatchModal() {
    const batchList = document.getElementById("batchList");
    batchList.innerHTML = "";
    batchSelection.forEach(item => {
        batchList.innerHTML += `<div>${item.vod_name}</div>`;
    });
    document.getElementById("batchModal").classList.add("show");
}

function closeBatchModal() {
    document.getElementById("batchModal").classList.remove("show");
}

function startBatchGeneration() {
    const logEl = document.getElementById("batchLog");
    logEl.textContent = "开始批量生成...\n";
    
    fetch("/api/generate/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: batchSelection })
    }).then(res => res.json()).then(data => {
        if (data.results) {
            data.results.forEach(res => {
                logEl.textContent += `${res.vod_name}: ${res.status} - ${res.msg}\n`;
            });
        }
        logEl.textContent += "批量处理完成！\n";
        // 清空选择
        batchSelection = [];
        updateBatchButton();
        // 刷新媒体库
        loadMyStrm();
    });
}

// ========== 我的媒体库 ==========
function loadMyStrm() {
    fetch("/api/my_strm")
        .then(res => res.json())
        .then(data => {
            if (data.ok) {
                const tbody = document.getElementById("myStrmList");
                tbody.innerHTML = "";
                data.list.forEach(item => {
                    tbody.innerHTML += `
                        <tr>
                            <td><img src="${getProxyImageUrl(item.vod_pic)}" /></td>
                            <td>${item.vod_name}</td>
                            <td>${item.type === "series" ? "剧集" : "电影"}</td>
                            <td>${item.updated_at}</td>
                            <td>${item.source_idx}</td>
                            <td>
                                <button class="btn" onclick="openSmartSwitch('${item.vod_name}', ${item.id})">换源</button>
                            </td>
                        </tr>
                    `;
                });
            }
        });
}

// 清理无效记录
function cleanInvalidDB() {
    if (confirm("确定要清理无效记录吗？")) {
        fetch("/api/system/clean_db", { method: "POST" })
            .then(res => res.json())
            .then(data => {
                alert(`已清理 ${data.deleted} 条无效记录`);
                loadMyStrm();
            });
    }
}

// ========== 智能换源 ==========
function openSmartSwitch(vodName, recordId) {
    document.getElementById("ssName").textContent = vodName;
    document.getElementById("smartSwitchModal").classList.add("show");
    document.getElementById("ssList").innerHTML = "搜索中...";
    
    // 搜索相同名称的资源
    fetch(`/api/vod/search?keyword=${encodeURIComponent(vodName)}`)
        .then(res => res.json())
        .then(data => {
            if (data.ok && data.list.length > 0) {
                const ssList = document.getElementById("ssList");
                ssList.innerHTML = "";
                data.list.forEach(item => {
                    ssList.innerHTML += `
                        <div class="source-tab" onclick="confirmSmartSwitch(${JSON.stringify(item)})">
                            ${item.vod_name} (源${item._source_index + 1})
                        </div>
                    `;
                });
            } else {
                document.getElementById("ssList").innerHTML = "未找到可替换的源";
            }
        });
}

function confirmSmartSwitch(item) {
    if (confirm(`确定要将 "${item.vod_name}" 替换为源${item._source_index + 1}的资源吗？`)) {
        fetch("/api/strm/smart_switch_confirm", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                vod_id: item.vod_id,
                vod_name: item.vod_name,
                vod_pic: item.vod_pic,
                source_index: item._source_index,
                play_source_idx: 0
            })
        }).then(res => res.json()).then(data => {
            const logEl = document.getElementById("ssLog");
            logEl.style.display = "block";
            if (data.logs) {
                data.logs.forEach(log => {
                    logEl.textContent += log + "\n";
                });
            }
            if (data.ok) {
                logEl.textContent += "✅ 换源成功！\n";
                loadMyStrm();
            } else {
                logEl.textContent += "❌ " + (data.msg || "换源失败") + "\n";
            }
        });
    }
}

function closeSmartSwitchModal() {
    document.getElementById("smartSwitchModal").classList.add("hidden");
}

// ========== 设置页面 ==========
function loadSettings() {
    fetch("/api/config")
        .then(res => res.json())
        .then(config => {
            document.getElementById("cfgSources").value = JSON.stringify(config.sources, null, 2);
            document.getElementById("cfgScheme").value = config.player_scheme;
            document.getElementById("cfgTmdb").value = config.tmdb_api_key;
            document.getElementById("cfgAntiBlock").checked = config.anti_block;
            document.getElementById("cfgImgProxy").checked = config.use_img_proxy;
            
            // 保存到本地存储供图片代理使用
            localStorage.setItem("useImgProxy", config.use_img_proxy);
        });
}

function saveSettings() {
    try {
        const sources = JSON.parse(document.getElementById("cfgSources").value);
        const config = {
            sources,
            player_scheme: document.getElementById("cfgScheme").value,
            tmdb_api_key: document.getElementById("cfgTmdb").value,
            anti_block: document.getElementById("cfgAntiBlock").checked,
            use_img_proxy: document.getElementById("cfgImgProxy").checked
        };
        
        fetch("/api/config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(config)
        }).then(res => res.json()).then(data => {
            if (data.ok) {
                alert("设置保存成功");
                loadSourceOptions();
                localStorage.setItem("useImgProxy", config.use_img_proxy);
            } else {
                alert("保存失败");
            }
        });
    } catch (e) {
        alert("资源源格式错误（必须是JSON数组）");
    }
}

// ========== 工具函数 ==========
function setStatus(text) {
    document.getElementById("statusText").textContent = text;
}

// 初始化
window.onload = function() {
    loadSourceOptions();
    loadCategories();
    loadVodList();
    loadSettings();
};