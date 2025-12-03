import os
import re
import json
import time
import sqlite3
import random
import asyncio
import aiohttp
import requests
import uvicorn
from typing import List, Optional, Dict, Any
from fastapi import FastAPI, Body, Query, HTTPException, Response
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# --- 基础配置 ---
DB_PATH = "data.db"
STRM_ROOT = "strm_library"
os.makedirs(STRM_ROOT, exist_ok=True)

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.mount("/web", StaticFiles(directory="web", html=True), name="web")

# --- 数据库初始化 ---
def init_db():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute('''CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)''')
    # 增加了 resolved_link_type 字段，用于记录最终解析出的链接类型（直链/短链）
    c.execute('''CREATE TABLE IF NOT EXISTS strm_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        vod_id TEXT,
        vod_name TEXT,
        vod_pic TEXT,
        type TEXT,
        save_path TEXT,
        source_api TEXT,      -- 记录匹配到的源的完整API地址
        source_idx INTEGER DEFAULT 0, -- 记录匹配到的源的索引
        resolved_link_type TEXT, -- 新增：记录最终链接类型 (direct/short_link)
        updated_at TEXT
    )''')
    # 初始化设置
    default_sources = ["https://cj.lziapi.com/api.php/provide/vod/"]
    c.execute("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", ("sources", json.dumps(default_sources)))
    c.execute("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", ("player_scheme", "SenPlayer://x-callback-url/play?url="))
    c.execute("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", ("tmdb_api_key", ""))
    c.execute("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", ("anti_block", "false"))
    c.execute("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", ("use_img_proxy", "false")) # 新增：强制图片代理
    conn.commit()
    conn.close()

init_db()

# --- 工具函数 ---
def get_db_setting(key, default=None):
    """从数据库获取配置"""
    with sqlite3.connect(DB_PATH) as conn:
        res = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        if not res: return default
        val = res[0]
        try:
            return json.loads(val)
        except:
            return val

def set_db_setting(key, value):
    """向数据库写入配置"""
    with sqlite3.connect(DB_PATH) as conn:
        val_str = json.dumps(value) if isinstance(value, (list, dict, bool)) else str(value)
        conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (key, val_str))
        conn.commit()

def safe_filename(name):
    """清理文件名中不允许的字符"""
    return re.sub(r'[\\/:*?"<>|]', '', str(name)).strip()

def get_random_ua():
    """获取随机用户代理"""
    uas = [
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0.3 Safari/605.1.15",
        "Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1"
    ]
    return random.choice(uas)

def request_with_retry(url, params=None, timeout=10):
    """请求封装，支持随机UA和防封延迟"""
    anti_block = get_db_setting("anti_block")
    # 数据库存的是字符串 "true" 或 bool true，做下兼容
    if str(anti_block).lower() == "true":
        time.sleep(random.uniform(0.5, 1.5))
    
    headers = {"User-Agent": get_random_ua()}
    try:
        r = requests.get(url, params=params, headers=headers, timeout=timeout, verify=False)
        r.raise_for_status()
        try:
            return r.json()
        except:
            # 有些API返回text/html但内容是json，或者编码不对
            r.encoding = r.apparent_encoding
            return json.loads(r.text)
    except Exception as e:
        print(f"[Error] Request {url}: {e}")
        return None

def resolve_short_link(url):
    """追踪302解析短链"""
    if not url.startswith("http"): return url
    # 已经是直链
    if re.search(r'\.(m3u8|mp4|avi|flv|mkv)$', url.split('?')[0], re.I):
        return url
        
    try:
        headers = {"User-Agent": get_random_ua()}
        # allow_redirects=True 会自动处理跳转，r.url 即为最终地址
        r = requests.get(url, headers=headers, timeout=6, allow_redirects=True, verify=False, stream=True)
        final_url = r.url
        r.close() # 只需要头信息和最终URL，不需要下载内容
        return final_url
    except Exception as e:
        print(f"Short link resolve error: {e}")
        return url

# --- 核心功能补充：图片代理 ---
@app.get("/api/proxy/img")
def proxy_image(url: str):
    """代理获取图片，解决Referrer防盗链问题"""
    if not url: return Response(status_code=404)
    try:
        headers = {
            "User-Agent": get_random_ua(),
            "Referer": "" # 关键：置空 Referer
        }
        r = requests.get(url, headers=headers, timeout=10, verify=False)
        return Response(content=r.content, media_type=r.headers.get("Content-Type", "image/jpeg"))
    except:
        # 返回一个透明像素或错误图
        return Response(status_code=404)

# --- TMDB & NFO (保持原逻辑) ---
def download_image(url, save_path):
    """下载图片"""
    try:
        # 使用空Referer下载
        headers = {"User-Agent": get_random_ua(), "Referer": ""}
        r = requests.get(url, timeout=15, headers=headers, verify=False)
        if r.status_code == 200:
            with open(save_path, 'wb') as f:
                f.write(r.content)
            return True
    except:
        pass
    return False

def fetch_tmdb_meta(api_key, name, year, media_type):
    """从 TMDB 获取影片元数据"""
    if not api_key: return None
    search_type = "tv" if media_type == "series" else "movie"
    url = f"https://api.themoviedb.org/3/search/{search_type}"
    params = {"api_key": api_key, "query": name, "language": "zh-CN"}
    if year and media_type == "movie": params["year"] = year
    try:
        data = request_with_retry(url, params)
        if data and data.get("results"):
            return data["results"][0]
    except:
        pass
    return None

def create_nfo(save_dir, meta_data, media_type):
    """创建 Kodi/Emby 兼容的 NFO 文件"""
    nfo_file = "tvshow.nfo" if media_type == "series" else "movie.nfo"
    path = os.path.join(save_dir, nfo_file)
    title = meta_data.get("title", meta_data.get("name", "Unknown"))
    plot = meta_data.get("overview", "")
    year = meta_data.get("release_date", meta_data.get("first_air_date", ""))[:4]
    tmdb_id = meta_data.get("id", "")
    xml = f"""<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<{media_type if media_type == 'movie' else 'tvshow'}>
  <title>{title}</title>
  <originaltitle>{meta_data.get('original_title', meta_data.get('original_name', ''))}</originaltitle>
  <plot>{plot}</plot>
  <year>{year}</year>
  <tmdbid>{tmdb_id}</tmdbid>
  <id>{tmdb_id}</id>
</{media_type if media_type == 'movie' else 'tvshow'}>"""
    with open(path, "w", encoding="utf-8") as f:
        f.write(xml)

# --- API 路由 ---
class ConfigModel(BaseModel):
    sources: List[str]
    player_scheme: str
    tmdb_api_key: str
    anti_block: bool
    use_img_proxy: bool

@app.get("/api/config")
def get_config():
    return {
        "sources": get_db_setting("sources", []),
        "player_scheme": get_db_setting("player_scheme"),
        "tmdb_api_key": get_db_setting("tmdb_api_key"),
        "anti_block": str(get_db_setting("anti_block")).lower() == "true",
        "use_img_proxy": str(get_db_setting("use_img_proxy")).lower() == "true"
    }

@app.post("/api/config")
def set_config(c: ConfigModel):
    set_db_setting("sources", c.sources)
    set_db_setting("player_scheme", c.player_scheme)
    set_db_setting("tmdb_api_key", c.tmdb_api_key)
    set_db_setting("anti_block", c.anti_block)
    set_db_setting("use_img_proxy", c.use_img_proxy)
    return {"ok": True}

@app.get("/api/vod/categories")
def get_categories(source_index: int = 0):
    sources = get_db_setting("sources", [])
    if not sources or source_index >= len(sources): return {"ok": False, "msg": "源无效"}
    data = request_with_retry(sources[source_index])
    if data and "class" in data:
        return {"ok": True, "class": data["class"]}
    return {"ok": False, "msg": "无法获取分类"}

@app.get("/api/vod/list")
def get_vod_list(source_index: int = 0, page: int = 1, type_id: str = ""):
    sources = get_db_setting("sources", [])
    if not sources or source_index >= len(sources): return {"ok": False, "msg": "请先配置源"}
    params = {"ac": "list", "pg": page}
    if type_id and type_id != "all": params["t"] = type_id
    data = request_with_retry(sources[source_index], params)
    return {"ok": True, "data": data} if data else {"ok": False, "msg": "请求失败"}

@app.get("/api/vod/detail")
def get_vod_detail(source_index: int, vod_id: str):
    sources = get_db_setting("sources", [])
    if not sources or source_index >= len(sources): return {"ok": False, "msg": "源索引错误"}
    
    data = request_with_retry(sources[source_index], params={"ac": "detail", "ids": vod_id})
    if data and data.get("list"):
        info = data["list"][0]
        # 解析逻辑与之前类似，但前端展示更详细
        play_url_raw = info.get("vod_play_url", "")
        play_from_raw = info.get("vod_play_from", "")
        sources_data = []
        urls = play_url_raw.split("$$$")
        froms = play_from_raw.split("$$$") if play_from_raw else []
        
        for idx, u in enumerate(urls):
            label = froms[idx] if idx < len(froms) else f"线路{idx+1}"
            episodes = []
            for ep_item in u.split("#"):
                parts = ep_item.split("$")
                ep_name = parts[0]
                ep_url = parts[1] if len(parts) > 1 else parts[0]
                episodes.append({"name": ep_name, "raw_url": ep_url})
            sources_data.append({"name": label, "url_content": u, "episodes": episodes})
            
        return {"ok": True, "data": info, "play_sources": sources_data}
    return {"ok": False, "msg": "详情获取失败"}

@app.get("/api/vod/search")
async def search_vod(keyword: str):
    sources = get_db_setting("sources", [])
    if not sources: return {"ok": False, "msg": "无源"}
    results = []
    
    async def fetch_one(idx, url):
        try:
            full_url = f"{url}?ac=list&wd={keyword}"
            async with aiohttp.ClientSession() as session:
                async with session.get(full_url, timeout=8, ssl=False) as resp:
                    if resp.status == 200:
                        txt = await resp.text()
                        try:
                            js = json.loads(txt)
                            if js.get("list"):
                                for item in js["list"]:
                                    item["_source_index"] = idx 
                                    item["_source_url"] = url
                                    results.append(item)
                        except: pass
        except: pass

    tasks = [fetch_one(i, s) for i, s in enumerate(sources)]
    await asyncio.gather(*tasks)
    return {"ok": True, "list": results}

# --- 生成逻辑 (增强版) ---

class GenerateReq(BaseModel):
    vod_id: str
    vod_name: str
    vod_pic: str
    vod_year: str
    type_name: str
    source_index: int     
    play_source_idx: int  
    url_content: Optional[str] = None # 可选，如果不传则后端重新获取
    only_replace_strm: bool = False   # 新增：是否只替换STRM而不下载图片/NFO

def process_generate(req: GenerateReq, is_batch=False):
    """
    处理单个或批量生成STRM文件的核心逻辑
    增加了详细日志输出，对TMDB匹配和海报下载也增加了日志
    """
    logs = []
    logs.append(f"正在处理资源: {req.vod_name} (ID: {req.vod_id}) 来自源索引 {req.source_index}")
    
    tmdb_key = get_db_setting("tmdb_api_key")
    sources = get_db_setting("sources", [])
    current_api_url = sources[req.source_index] if sources and req.source_index < len(sources) else "" # 获取完整的API URL
    
    # 如果没传 url_content，说明是批量或智能换源，需要重新获取详情
    if not req.url_content:
        logs.append(f"正在重新获取资源详情 (ID: {req.vod_id})...")
        try:
            detail_res = request_with_retry(current_api_url, params={"ac": "detail", "ids": req.vod_id})
            if detail_res and detail_res.get("list"):
                info = detail_res["list"][0]
                urls = info.get("vod_play_url", "").split("$$$")
                # 确保索引不越界
                idx = req.play_source_idx if req.play_source_idx < len(urls) else 0
                req.url_content = urls[idx]
                req.vod_name = info.get("vod_name", req.vod_name)
                req.type_name = info.get("type_name", req.type_name)
                req.vod_year = info.get("vod_year", req.vod_year)
                logs.append(f"资源详情获取成功: {req.vod_name}, 类型: {req.type_name}")
            else:
                logs.append("无法获取资源详情。")
                return {"ok": False, "msg": "无法获取资源详情", "logs": logs}
        except Exception as e:
            logs.append(f"详情获取异常: {str(e)}")
            return {"ok": False, "msg": f"详情获取异常: {str(e)}", "logs": logs}

    is_series = "剧" in req.type_name or "集" in req.type_name or "Season" in req.vod_name
    media_type = "series" if is_series else "movie"
    logs.append(f"识别类型: {media_type} (基于类型名: {req.type_name})")
    
    # 路径处理
    name_safe = safe_filename(req.vod_name)
    year = safe_filename(req.vod_year) if req.vod_year else ""
    
    # 如果是智能换源模式，我们需要找到原来的路径，而不是新建
    if req.only_replace_strm:
        with sqlite3.connect(DB_PATH) as conn:
            # 尝试通过 vod_name 查找记录 (因为 vod_id 在不同源可能不同，换源时不靠谱，靠名字)
            # 这里简化逻辑：如果是换源，通常用户是在"我的媒体库"操作，前端会传 old_path 或 record_id
            # 但 GenerateReq 设计是通用的。这里我们假设如果 only_replace_strm 为真，
            # 系统应该去检查 strm_records 中 vod_name 对应的目录。
            rec = conn.execute("SELECT save_path FROM strm_records WHERE vod_name=?", (req.vod_name,)).fetchone()
            if rec and os.path.exists(rec[0]):
                base_dir = rec[0]
                logs.append(f"智能换源模式：定位到现有目录 {base_dir}")
            else:
                logs.append("未找到原有记录，将创建新目录。")
                folder_name = f"{name_safe} ({year})" if year else name_safe
                base_dir = os.path.join(STRM_ROOT, "TV Series" if is_series else "Movies", folder_name)
    else:
        folder_name = f"{name_safe} ({year})" if year else name_safe
        base_dir = os.path.join(STRM_ROOT, "TV Series" if is_series else "Movies", folder_name)
        
    os.makedirs(base_dir, exist_ok=True)
    logs.append(f"目标保存目录: {base_dir}")
    
    # 仅在非只替换模式下处理 TMDB 和海报 (问题7: info信息)
    if not req.only_replace_strm:
        if tmdb_key:
            logs.append("尝试 TMDB 匹配...")
            meta = fetch_tmdb_meta(tmdb_key, req.vod_name, req.vod_year, media_type)
            if meta:
                create_nfo(base_dir, meta, media_type)
                logs.append(f"TMDB 匹配成功: {meta.get('title', meta.get('name'))} (ID: {meta.get('id')}), NFO文件已生成。")
                if meta.get("poster_path"):
                    logs.append("下载 TMDB 海报和背景图...")
                    download_image(f"https://image.tmdb.org/t/p/w500{meta['poster_path']}", os.path.join(base_dir, "poster.jpg"))
                    download_image(f"https://image.tmdb.org/t/p/original{meta.get('backdrop_path')}", os.path.join(base_dir, "fanart.jpg"))
                    logs.append("TMDB 海报和背景图下载完成。")
                else:
                    logs.append("TMDB 无海报路径。")
            else:
                logs.append("TMDB 未找到匹配项。")
        else:
            logs.append("未配置 TMDB API Key，跳过 TMDB 匹配。")
        
        # 下载 VOD 原始海报作为保底 (问题6: 首页海报不显示)
        if not os.path.exists(os.path.join(base_dir, "poster.jpg")) and req.vod_pic:
             logs.append(f"TMDB 无海报或未配置，尝试下载 VOD 源海报: {req.vod_pic[:40]}...")
             if download_image(req.vod_pic, os.path.join(base_dir, "poster.jpg")):
                 logs.append("VOD 源海报下载成功。")
             else:
                 logs.append("VOD 源海报下载失败。")

    # 解析与写入 STRM (增强逻辑) (问题2: 短链优先直链)
    episodes = req.url_content.split("#")
    count = 0
    resolved_type_for_db = "unknown" # 默认为未知类型
    
    for idx, ep in enumerate(episodes):
        parts = ep.split("$")
        ep_name = parts[0]
        raw_url = parts[1] if len(parts) > 1 else parts[0]
        
        if not raw_url.startswith("http"):
            logs.append(f"[{ep_name}] 链接无效 (非HTTP/HTTPS)。")
            continue
        
        # 智能双重解析：直链优先 -> 失败则解析短链
        final_url = raw_url
        is_direct_initial = re.search(r'\.(m3u8|mp4|avi|flv|mkv)$', raw_url.split('?')[0], re.I)
        
        if is_direct_initial:
            logs.append(f"[{ep_name}] 原始链接已是直链。")
            resolved_type_for_db = "direct"
        else:
            logs.append(f"[{ep_name}] 原始链接非直链，尝试解析...")
            resolved = resolve_short_link(raw_url)
            if resolved != raw_url:
                # 检查解析后的链接是否为直链
                if re.search(r'\.(m3u8|mp4|avi|flv|mkv)$', resolved.split('?')[0], re.I):
                    logs.append(f"-> 解析成功为直链: {resolved[:40]}...")
                    resolved_type_for_db = "direct"
                else:
                    logs.append(f"-> 解析成功但仍为短链: {resolved[:40]}...")
                    resolved_type_for_db = "short_link"
                final_url = resolved
            else:
                logs.append("-> 解析未变化，保留原链接(可能需要Webview播放)。")
                resolved_type_for_db = "short_link" # 未解析出直链，视为短链
        
        # 写入 STRM 文件 (问题3: 区分电影和剧集目录结构)
        if is_series:
            season_dir = os.path.join(base_dir, "Season 01")
            os.makedirs(season_dir, exist_ok=True)
            ep_num = idx + 1
            # 尝试从名字提取数字
            m = re.search(r'(\d+)', ep_name)
            if m: ep_num = int(m.group(1))
            strm_path = os.path.join(season_dir, f"{name_safe} - S01E{ep_num:02d}.strm")
            logs.append(f"生成剧集STRM: {os.path.basename(strm_path)}")
        else:
            if count > 0: continue # 电影只取第一个
            strm_path = os.path.join(base_dir, f"{folder_name}.strm")
            logs.append(f"生成电影STRM: {os.path.basename(strm_path)}")
            
        with open(strm_path, "w", encoding="utf-8") as f:
            f.write(final_url)
        count += 1
        if not is_series: break # 电影只生成一个STRM文件

    if count == 0:
        logs.append("未生成任何有效STRM文件。")
        return {"ok": False, "msg": "未生成任何有效STRM文件", "logs": logs}

    # 更新数据库 (问题1: strm增加匹配源及详情，问题5: 详细日志)
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    with sqlite3.connect(DB_PATH) as conn:
        # 如果已经存在，更新；如果不存在且不是only_replace，插入
        # 这里用 vod_name 做唯一性更适合 Emby 用户的使用场景
        exist = conn.execute("SELECT id FROM strm_records WHERE vod_name=?", (req.vod_name,)).fetchone()
        
        if exist:
            # 更新现有记录时也更新 resolved_link_type
            conn.execute("UPDATE strm_records SET updated_at=?, source_api=?, source_idx=?, vod_pic=?, resolved_link_type=? WHERE id=?", 
                         (ts, current_api_url, req.source_index, req.vod_pic, resolved_type_for_db, exist[0]))
            logs.append(f"数据库记录已更新 (ID: {exist[0]})。")
        elif not req.only_replace_strm:
            # 插入新记录时包含 resolved_link_type
            conn.execute("INSERT INTO strm_records (vod_id, vod_name, vod_pic, type, save_path, source_api, source_idx, resolved_link_type, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
                         (req.vod_id, req.vod_name, req.vod_pic, media_type, base_dir, current_api_url, req.source_index, resolved_type_for_db, ts))
            logs.append("数据库新记录已插入。")
        conn.commit()
            
    logs.append(f"✅ 处理完成，共生成 {count} 个文件。")
    return {"ok": True, "count": count, "logs": logs, "path": base_dir}

@app.post("/api/generate/single")
def generate_strm_single(req: GenerateReq):
    return process_generate(req)

class BatchReq(BaseModel):
    items: List[GenerateReq]

@app.post("/api/generate/batch")
async def generate_strm_batch(req: BatchReq):
    """
    批量生成STRM文件 (问题4: 批量生成完善)
    """
    results = []
    total_items = len(req.items)
    logs = []
    
    # 智能防风控策略
    # 如果总数超过5个，开启强制随机延迟
    use_delay = total_items > 5 
    logs.append(f"批量处理 {total_items} 项资源。防风控模式: {'开启' if use_delay else '关闭'}")
    
    for i, item in enumerate(req.items):
        current_item_logs = []
        if use_delay and i > 0:
            delay = random.uniform(1.5, 4.0)
            current_item_logs.append(f"防风控延迟: {delay:.2f}s...")
            time.sleep(delay)
            
        try:
            # process_generate 内部已经包含了重新获取详情的逻辑和详细日志
            res = process_generate(item, is_batch=True)
            current_item_logs.extend(res.get("logs", [])) # 合并子任务的详细日志
            results.append({
                "vod_name": item.vod_name, 
                "status": "成功" if res["ok"] else "失败", 
                "msg": res.get("msg", ""),
                "logs": current_item_logs
            })
        except Exception as e:
            current_item_logs.append(f"处理过程中发生异常: {str(e)}")
            results.append({"vod_name": item.vod_name, "status": "异常", "msg": str(e), "logs": current_item_logs})
        
    logs.append("所有批量任务已完成。")
    return {"ok": True, "results": results, "logs": logs} # 额外返回顶层批量日志

@app.get("/api/my_strm")
def my_strm_list():
    """
    获取我的媒体库列表
    包含了 source_api 和 resolved_link_type
    """
    with sqlite3.connect(DB_PATH) as conn:
        # 从数据库中选择所有字段，包括新增的 resolved_link_type
        rows = conn.execute("SELECT id, vod_id, vod_name, vod_pic, type, save_path, source_api, source_idx, resolved_link_type, updated_at FROM strm_records ORDER BY updated_at DESC").fetchall()
    res = []
    for r in rows:
        res.append({
            "id": r[0], 
            "vod_id": r[1], 
            "vod_name": r[2], 
            "vod_pic": r[3], 
            "type": r[4], 
            "path": r[5], 
            "source_api": r[6], 
            "source_idx": r[7], 
            "resolved_link_type": r[8], # 使用正确的索引
            "updated_at": r[9]
        })
    return {"ok": True, "list": res}

@app.post("/api/strm/smart_switch_confirm")
def confirm_smart_switch(req: GenerateReq):
    """
    智能换源确认接口
    前端已经搜索并让用户选择了新的源 (req中包含了新源的 source_index, vod_id 等)
    这里复用 process_generate，但开启 only_replace_strm 模式
    """
    req.only_replace_strm = True
    # 默认选择第一个播放线路，或者由前端传入 play_source_idx
    return process_generate(req)

@app.post("/api/system/clean_db")
def clean_invalid_records():
    """清理不存在路径的数据库记录"""
    with sqlite3.connect(DB_PATH) as conn:
        rows = conn.execute("SELECT id, save_path FROM strm_records").fetchall()
        deleted = 0
        for r in rows:
            if not os.path.exists(r[1]):
                conn.execute("DELETE FROM strm_records WHERE id=?", (r[0],))
                deleted += 1
        conn.commit()
    return {"ok": True, "deleted": deleted}

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)

