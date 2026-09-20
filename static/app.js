// osu! Mapper Downloader - Classic Web 1.0 logic

const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
})[char]);

class App {
    constructor() {
        this.beatmapsets = [];
        this.selectedIds = new Set();
        this.downloadedIds = new Set();
        this.downloadedMtimes = new Map();
        this.failedIds = new Set();
        
        this.downloadQueue = []; // Full list of IDs queued
        this.activeQueue = [];
        this.isDownloading = false;
        this.maps = []; // Store currently fetched maps
        this.mapsById = new Map();
        this.currentAudioId = null;
        
        this.viewMode = 'table';
        
        // Pagination state
        this.currentCursor = null;
        this.searchMode = 'mapper';
        
        // Search history
        this.searchHistory = JSON.parse(localStorage.getItem('searchHistory') || '[]');
        
        // Cache DOM
        this.tbody = document.getElementById('beatmap-tbody');
        this.gridContainer = document.getElementById('beatmap-grid');
        this.tableWrapper = document.getElementById('beatmap-table-wrapper');
        this.gridWrapper = document.getElementById('beatmap-grid-wrapper');
        
        this.searchInput = document.getElementById('search-query');
        this.filterInput = document.getElementById('text-filter');
        this.sortSelect = document.getElementById('sort-select');
        this.showDownloadedCb = document.getElementById('show-downloaded');
        
        this.consoleLogList = document.getElementById('console-log');
        this.tooltip = document.getElementById('img-tooltip');
        this.tooltipImg = document.getElementById('img-tooltip-src');
        this.queueListEl = document.getElementById('queue-list');
        
        // Bind Events
        document.getElementById('text-filter').addEventListener('input', () => this.render());
        document.getElementById('sort-select').addEventListener('change', () => this.render());
        document.getElementById('show-downloaded').addEventListener('change', () => this.render());
        
        document.getElementById('topplay-mode').addEventListener('change', () => {
            if (this.searchMode === 'topplays' && this.searchInput.value.trim()) {
                this.searchTopPlays();
            }
        });

        // Two-way sync for Global Search textbox and dropdowns
        const globalMode = document.getElementById('global-mode');
        const globalStatus = document.getElementById('global-status');
        
        const syncSearchToDropdowns = () => {
            if (this.searchMode !== 'global') return;
            let query = this.searchInput.value;
            const modeMatch = query.match(/\b(?:mode|m)=(osu|o|taiko|t|catch|c|fruits|mania|m)\b/i);
            const statusMatch = query.match(/\b(?:status|s)=(ranked|r|approved|a|qualified|q|loved|l|pending|p|wip|w|graveyard|g)\b/i);
            
            if (modeMatch) {
                const m = modeMatch[1].toLowerCase();
                if (['osu', 'o'].includes(m)) globalMode.value = 'osu';
                else if (['taiko', 't'].includes(m)) globalMode.value = 'taiko';
                else if (['catch', 'c', 'fruits'].includes(m)) globalMode.value = 'fruits';
                else if (['mania', 'm'].includes(m)) globalMode.value = 'mania';
            } else {
                globalMode.value = '';
            }
            
            if (statusMatch) {
                const s = statusMatch[1].toLowerCase();
                if (['ranked', 'r', 'approved', 'a'].includes(s)) globalStatus.value = 'ranked';
                else if (['qualified', 'q'].includes(s)) globalStatus.value = 'qualified';
                else if (['loved', 'l'].includes(s)) globalStatus.value = 'loved';
                else if (['pending', 'p', 'wip', 'w'].includes(s)) globalStatus.value = 'pending';
                else if (['graveyard', 'g'].includes(s)) globalStatus.value = 'graveyard';
            } else {
                globalStatus.value = '';
            }
        };

        const syncDropdownsToSearch = () => {
            if (this.searchMode !== 'global') return;
            let query = this.searchInput.value;
            
            query = query.replace(/\b(?:mode|m)=(osu|o|taiko|t|catch|c|fruits|mania|m)\b/gi, '').trim();
            if (globalMode.value) query += ` mode=${globalMode.value}`;
            
            query = query.replace(/\b(?:status|s)=(ranked|r|approved|a|qualified|q|loved|l|pending|p|wip|w|graveyard|g)\b/gi, '').trim();
            if (globalStatus.value) query += ` status=${globalStatus.value}`;
            
            this.searchInput.value = query.replace(/\s+/g, ' ').trim();
        };

        this.searchInput.addEventListener('input', syncSearchToDropdowns);
        globalMode.addEventListener('change', syncDropdownsToSearch);
        globalStatus.addEventListener('change', syncDropdownsToSearch);
        
        document.querySelectorAll('input[name="view-mode"]').forEach(radio => {
            radio.addEventListener('change', (e) => {
                this.viewMode = e.target.value;
                this.render();
            });
        });
        
        // Tooltip mouse tracking
        document.addEventListener('mousemove', (e) => {
            if (this.tooltip.style.display === 'block') {
                this.tooltip.style.left = (e.clientX + 15) + 'px';
                this.tooltip.style.top = (e.clientY + 15) + 'px';
            }
        });
        
        // Load Dark Mode pref
        if (localStorage.getItem('darkMode') === '1') {
            document.body.classList.add('dark-mode');
        }
        
        this.loadConfig();
        this.renderSearchHistory();
    }
    
    toggleDarkMode() {
        document.body.classList.toggle('dark-mode');
        if (document.body.classList.contains('dark-mode')) {
            localStorage.setItem('darkMode', '1');
        } else {
            localStorage.setItem('darkMode', '0');
        }
    }
    
    switchTab(tabId) {
        document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
        document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
        
        document.getElementById(`tab-${tabId}`).classList.add('active');
        const btns = document.querySelectorAll('.tab-btn');
        if (tabId === 'browser') btns[0].classList.add('active');
        else if (tabId === 'history') {
            btns[1].classList.add('active');
            this.loadHistory();
        }
        else if (tabId === 'log') btns[2].classList.add('active');
    }

    async loadHistory() {
        try {
            const res = await fetch('/api/history');
            const data = await res.json();
            const tbody = document.getElementById('history-tbody');
            tbody.innerHTML = '';
            
            if (!data.history || data.history.length === 0) {
                tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;">No history found.</td></tr>';
                return;
            }
            
            data.history.forEach(item => {
                const tr = document.createElement('tr');
                [item.date, item.id, item.filename, item.mirror].forEach((value, index) => {
                    const td = document.createElement('td');
                    if (index === 1) {
                        const link = document.createElement('a');
                        link.href = `https://osu.ppy.sh/beatmapsets/${encodeURIComponent(item.id)}`;
                        link.target = '_blank';
                        link.rel = 'noopener';
                        link.textContent = item.id;
                        td.appendChild(link);
                    } else td.textContent = value;
                    tr.appendChild(td);
                });
                tbody.appendChild(tr);
            });
        } catch (e) {
            this.logConsole("Failed to load history: " + e.message, "err");
        }
    }

    async loadConfig() {
        try {
            const r = await fetch('/api/config');
            const data = await r.json();
            const display = document.getElementById('songs-path-display');
            display.replaceChildren('Songs folder: ');
            const path = document.createElement('code');
            path.textContent = data.songs_path || '';
            display.appendChild(path);
        } catch (e) {
            this.logConsole("Error loading config", "err");
        }
    }
    
    showToast(msg, type='info') {
        const c = document.getElementById('toast-container');
        const t = document.createElement('div');
        t.className = `toast ${type}`;
        t.textContent = msg;
        c.appendChild(t);
        setTimeout(() => t.remove(), 4000);
    }
    
    logConsole(msg, type='ok') {
        const d = new Date();
        const time = `[${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}:${d.getSeconds().toString().padStart(2,'0')}]`;
        
        const li = document.createElement('li');
        li.className = `log-${type}`;
        li.textContent = `${time} ${msg}`;
        this.consoleLogList.appendChild(li);
        
        const page = document.querySelector('.console-log-page');
        if(page) page.scrollTop = page.scrollHeight;
    }
    
    async openFolder() {
        try {
            const r = await fetch('/api/open-folder', {method: 'POST'});
            if (!r.ok) throw new Error("Failed to open");
            this.logConsole("Opened Songs folder in Windows Explorer.", "ok");
        } catch (e) {
            this.logConsole("Could not open folder.", "err");
        }
    }

    async openHistoryLog() {
        try {
            const r = await fetch('/api/open-history', {method: 'POST'});
            if (!r.ok) throw new Error("Failed to open");
            this.logConsole("Opened download history file.", "ok");
        } catch (e) {
            this.logConsole("Could not open history file.", "err");
        }
    }
    
    applyFilters() {
        this.render();
    }
    
    updateVolume() {
        const audio = document.getElementById('preview-audio');
        const volSlider = document.getElementById('preview-volume');
        if (audio && volSlider) {
            audio.volume = volSlider.value;
        }
    }

    toggleAudio(id) {
        const audio = document.getElementById('preview-audio');
        
        // Ensure volume is synced
        this.updateVolume();
        
        // Remove playing class from all buttons
        document.querySelectorAll('.play-btn, .thumb-play-btn').forEach(el => el.classList.remove('playing'));
        
        if (this.currentAudioId === id && !audio.paused) {
            audio.pause();
            this.currentAudioId = null;
            return;
        }
        
        this.currentAudioId = id;
        audio.src = `https://b.ppy.sh/preview/${id}.mp3`;
        audio.play().catch(e => this.logConsole("Audio preview failed: " + e.message, "err"));
        
        // Add playing class to related buttons
        const btns = document.querySelectorAll(`.play-btn-${id}`);
        btns.forEach(btn => btn.classList.add('playing'));
        
        audio.onended = () => {
            this.currentAudioId = null;
            document.querySelectorAll('.play-btn, .thumb-play-btn').forEach(el => el.classList.remove('playing'));
        };
    }

    toggleSearchMode() {
        const mode = document.querySelector('input[name="search-mode"]:checked').value;
        this.searchMode = mode;
        document.getElementById('global-filters').style.display = mode === 'global' ? 'block' : 'none';
        document.getElementById('topplay-filters').style.display = mode === 'topplays' ? 'block' : 'none';

        if (mode === 'global') {
            this.searchInput.placeholder = 'Search by title, artist, tags...';
        } else if (mode === 'topplays') {
            this.searchInput.placeholder = 'Search player top plays (e.g. mrekk)...';
        } else {
            this.searchInput.placeholder = 'Search mapper (e.g. Sotarks)...';
        }
    }

    resetGlobalFilters() {
        ['global-mode', 'global-status', 'global-sort'].forEach(id => document.getElementById(id).value = '');
        if (this.searchMode === 'global' && this.searchInput.value.trim()) this.globalSearch();
    }

    performSearch() {
        const query = this.searchInput.value.trim();
        if (query) this.saveSearchHistory(query, this.searchMode);
        if (this.searchMode === 'global') {
            this.currentCursor = null; // reset pagination
            this.globalSearch();
        } else if (this.searchMode === 'topplays') {
            this.searchTopPlays();
        } else {
            this.searchMapper();
        }
    }
    
    saveSearchHistory(query, mode) {
        this.searchHistory = this.searchHistory.filter(h => !(h.query === query && h.mode === mode));
        this.searchHistory.unshift({ query, mode, time: Date.now() });
        if (this.searchHistory.length > 10) this.searchHistory.length = 10;
        localStorage.setItem('searchHistory', JSON.stringify(this.searchHistory));
        this.renderSearchHistory();
    }
    
    renderSearchHistory() {
        const container = document.getElementById('search-history');
        if (!container) return;
        container.innerHTML = '';
        if (this.searchHistory.length === 0) return;
        
        const label = document.createElement('span');
        label.textContent = 'Recent: ';
        label.style.cssText = 'font-size:11px; color:#777;';
        container.appendChild(label);
        
        this.searchHistory.slice(0, 6).forEach(h => {
            const chip = document.createElement('span');
            const modeLabel = h.mode === 'global' ? '🔍' : h.mode === 'topplays' ? '🏆' : '🗺️';
            chip.textContent = `${modeLabel} ${h.query}`;
            chip.title = `${h.mode}: ${h.query}`;
            chip.style.cssText = 'display:inline-block; background:#e0e0e0; border:1px solid #bbb; padding:1px 6px; margin:2px 3px; font-size:11px; cursor:pointer; border-radius:2px;';
            chip.addEventListener('click', () => {
                this.searchInput.value = h.query;
                // Switch to the right mode
                const radio = document.querySelector(`input[name="search-mode"][value="${h.mode}"]`);
                if (radio) { radio.checked = true; this.toggleSearchMode(); }
                this.performSearch();
            });
            container.appendChild(chip);
        });
        
        const clearBtn = document.createElement('span');
        clearBtn.textContent = '✕ clear';
        clearBtn.style.cssText = 'font-size:10px; color:#999; cursor:pointer; margin-left:5px;';
        clearBtn.addEventListener('click', () => {
            this.searchHistory = [];
            localStorage.removeItem('searchHistory');
            this.renderSearchHistory();
        });
        container.appendChild(clearBtn);
    }
    
    clearSearch() {
        this.searchInput.value = '';
        this.searchInput.focus();
    }
    
    async refreshDownloadedStatus() {
        try {
            await this.loadDownloadsCache();
            this.render();
            this.updateStatsDisplay();
            this.logConsole(`Refreshed: found ${this.downloadedIds.size} downloaded maps.`, 'ok');
            this.showToast(`Found ${this.downloadedIds.size} downloaded maps`, 'ok');
        } catch (e) {
            this.logConsole('Failed to refresh downloaded status: ' + e.message, 'err');
        }
    }
    
    async loadDownloadsCache() {
        try {
            const dlRes = await fetch(`/api/downloaded?t=${Date.now()}`, { cache: 'no-store' });
            const dlData = await dlRes.json();
            this.downloadedIds = new Set();
            this.downloadedMtimes = new Map();
            if (dlData.downloads) {
                if (Array.isArray(dlData.downloads)) {
                    // Legacy cached response fallback
                    dlData.downloads.forEach(id => {
                        this.downloadedIds.add(id);
                        this.downloadedMtimes.set(id, Infinity); // Don't flag as outdated if legacy cache is used
                    });
                } else {
                    for (const [idStr, mtime] of Object.entries(dlData.downloads)) {
                        const id = parseInt(idStr);
                        this.downloadedIds.add(id);
                        this.downloadedMtimes.set(id, mtime);
                    }
                }
            }
        } catch (e) {
            this.logConsole("Failed to load downloads cache: " + e.message, "err");
        }
    }

    async globalSearch(isLoadMore = false) {
        const query = this.searchInput.value.trim();
        
        if (!isLoadMore) {
            this.switchTab('browser');
            document.getElementById('mapper-info').style.display = 'none';
            document.getElementById('controls').style.display = 'none';
            this.tableWrapper.style.display = 'none';
            this.gridWrapper.style.display = 'none';
            document.getElementById('empty-state').style.display = 'none';
            document.getElementById('pagination-controls').style.display = 'none';
            document.getElementById('loading').style.display = 'block';
            this.logConsole(`Performing global search for: ${query}...`, "info");
        } else {
            document.getElementById('load-more-btn').textContent = "Loading...";
            document.getElementById('load-more-btn').disabled = true;
        }
        
        try {
            await this.loadDownloadsCache();
            
            const sort = document.getElementById('global-sort').value;
            let url = `/api/search?q=${encodeURIComponent(query)}&sort=${encodeURIComponent(sort)}`;
            if (this.currentCursor) {
                url += `&cursor_string=${encodeURIComponent(this.currentCursor)}`;
            }
            
            const res = await fetch(url);
            if (!res.ok) throw new Error(await res.text());
            const data = await res.json();
            
            if (!isLoadMore) {
                this.maps = data.beatmapsets || [];
                this.beatmapsets = this.maps;
            } else {
                if (data.beatmapsets) {
                    this.maps.push(...data.beatmapsets);
                }
            }
            this.indexMaps();
            
            this.currentCursor = data.cursor_string;
            
            if (this.maps.length === 0) {
                document.getElementById('loading').style.display = 'none';
                document.getElementById('empty-state').style.display = 'block';
                return;
            }
            
            // Hide avatar, change title for global
            document.getElementById('mapper-avatar').style.display = 'none';
            document.getElementById('mapper-name').textContent = `Global Search: ${query || 'Any'}`;
            document.getElementById('mapper-rank').parentElement.style.display = 'none';
            
            this.updateStatsDisplay();
            this.render();
            
            document.getElementById('loading').style.display = 'none';
            document.getElementById('controls').style.display = 'block';
            document.getElementById('mapper-info').style.display = 'block';
            document.getElementById('topplay-quick-actions').style.display = 'none';
            
            if (this.currentCursor) {
                document.getElementById('pagination-controls').style.display = 'block';
            } else {
                document.getElementById('pagination-controls').style.display = 'none';
            }
            
        } catch (e) {
            this.logConsole("Global search failed: " + e.message, "err");
            document.getElementById('loading').style.display = 'none';
        } finally {
            if (isLoadMore) {
                document.getElementById('load-more-btn').textContent = "Load More Results...";
                document.getElementById('load-more-btn').disabled = false;
            }
        }
    }

    loadMore() {
        if (this.searchMode === 'global') {
            this.globalSearch(true);
        }
    }

    async searchTopPlays() {
        const username = this.searchInput.value.trim();
        if (!username) return;
        this.switchTab('browser');
        document.getElementById('loading').style.display = 'block';
        document.getElementById('empty-state').style.display = 'none';
        this.tableWrapper.style.display = 'none';
        this.gridWrapper.style.display = 'none';
        document.getElementById('controls').style.display = 'none';
        document.getElementById('pagination-controls').style.display = 'none';
        try {
            await this.loadDownloadsCache();
            const modeSelector = document.getElementById('topplay-mode').value;
            const modeQuery = modeSelector ? `?mode=${modeSelector}` : '';
            const userResponse = await fetch(`/api/user/${encodeURIComponent(username)}${modeQuery}`);
            if (!userResponse.ok) throw new Error((await userResponse.json()).error || 'Player not found');
            const user = await userResponse.json();
            
            const modeParam = modeSelector ? `&mode=${modeSelector}` : '';
            const scoreResponse = await fetch(`/api/users/${user.id}/top-plays?limit=100${modeParam}`);
            
            if (!scoreResponse.ok) throw new Error((await scoreResponse.json()).error || 'Could not load top plays');
            this.maps = (await scoreResponse.json()).top_plays || [];
            this.beatmapsets = this.maps;
            this.indexMaps();
            this.selectedIds.clear();
            this.failedIds.clear();
            document.getElementById('mapper-avatar').src = user.avatar_url || '';
            document.getElementById('mapper-avatar').style.display = 'block';
            document.getElementById('mapper-profile-link').href = `https://osu.ppy.sh/users/${user.id}`;
            document.getElementById('mapper-name').textContent = `${user.username} — Top Plays`;
            document.getElementById('mapper-rank').textContent = (user.statistics.global_rank || '-').toLocaleString();
            document.getElementById('mapper-playcount').textContent = (user.statistics.play_count || 0).toLocaleString();
            document.getElementById('mapper-country').textContent = user.country_code || '-';
            document.getElementById('mapper-rank').parentElement.style.display = 'block';
            this.updateStatsDisplay();
            this.render();
            document.getElementById('mapper-info').style.display = 'block';
            document.getElementById('controls').style.display = 'block';
            document.getElementById('topplay-quick-actions').style.display = 'block';
            if (!this.maps.length) document.getElementById('empty-state').style.display = 'block';
            this.logConsole(`Loaded ${this.maps.length} unique top-play maps for ${user.username}.`, 'ok');
        } catch (error) {
            this.logConsole(`Top plays search failed: ${error.message}`, 'err');
            this.showToast(error.message, 'err');
        } finally {
            document.getElementById('loading').style.display = 'none';
        }
    }

    async searchMapper() {
        const username = this.searchInput.value.trim();
        if (!username) return;
        
        this.switchTab('browser');
        document.getElementById('mapper-info').style.display = 'none';
        document.getElementById('controls').style.display = 'none';
        this.tableWrapper.style.display = 'none';
        this.gridWrapper.style.display = 'none';
        document.getElementById('empty-state').style.display = 'none';
        document.getElementById('pagination-controls').style.display = 'none';
        document.getElementById('loading').style.display = 'block';
        
        this.logConsole(`Searching for mapper: ${username}...`, "info");
        
        try {
            await this.loadDownloadsCache();
            this.logConsole(`Found ${this.downloadedIds.size} already downloaded maps in Songs folder.`, "ok");
            
            const uRes = await fetch(`/api/user/${encodeURIComponent(username)}`);
            if (!uRes.ok) throw new Error(await uRes.text());
            const uData = await uRes.json();
            
            if (!uData.id) throw new Error("Invalid user data");
            
            document.getElementById('mapper-name').textContent = uData.username;
            document.getElementById('mapper-profile-link').href = `https://osu.ppy.sh/users/${uData.id}`;
            document.getElementById('mapper-avatar').src = uData.avatar_url || '';
            document.getElementById('mapper-avatar').style.display = 'block';
            document.getElementById('mapper-rank').parentElement.style.display = 'block';
            
            document.getElementById('mapper-rank').textContent = (uData.statistics.global_rank || '-').toLocaleString();
            document.getElementById('mapper-playcount').textContent = (uData.statistics.play_count || 0).toLocaleString();
            document.getElementById('mapper-country').textContent = uData.country_code || '-';
            
            const bRes = await fetch(`/api/beatmapsets/${uData.id}`);
            if (!bRes.ok) throw new Error(await bRes.text());
            const data = (await bRes.json()).beatmapsets || [];
            
            this.selectedIds.clear();
            this.failedIds.clear();
            
            this.logConsole(`Found ${data.length} beatmapsets for ${username}.`, "ok");
            this.maps = data;
            this.beatmapsets = data;
            this.indexMaps();
            
            this.updateStatsDisplay();
            this.render();
            
            document.getElementById('loading').style.display = 'none';
            document.getElementById('controls').style.display = 'block';
            document.getElementById('mapper-info').style.display = 'block';
            document.getElementById('pagination-controls').style.display = 'none';
            document.getElementById('topplay-quick-actions').style.display = 'none';
            
            if (this.beatmapsets.length === 0) {
                document.getElementById('empty-state').style.display = 'block';
                this.logConsole("No beatmaps found.", "warn");
            } else {
                this.logConsole(`Loaded ${this.beatmapsets.length} beatmapsets successfully.`, "ok");
                document.getElementById('controls').style.display = 'block';
            }
        } catch (e) {
            document.getElementById('loading').style.display = 'none';
            this.logConsole(`Error: ${e.message}`, "err");
        }
    }
    

    updateStatsDisplay() {
        let totalMaps = this.maps.length;
        let downloadedCount = 0;
        let modeCounts = { osu: 0, taiko: 0, fruits: 0, mania: 0 };
        const modeIdMap = { 0: 'osu', 1: 'taiko', 2: 'fruits', 3: 'mania' };
        
        this.maps.forEach(m => {
            if (this.downloadedIds.has(m.id)) {
                downloadedCount++;
            }
            if (m.beatmaps && m.beatmaps.length > 0) {
                const modes = new Set(m.beatmaps.map(b => b.mode));
                if (modes.has('osu')) modeCounts.osu++;
                if (modes.has('taiko')) modeCounts.taiko++;
                if (modes.has('fruits')) modeCounts.fruits++;
                if (modes.has('mania')) modeCounts.mania++;
            } else if (m._top_play) {
                // Fallback: use mode from the score itself
                let mode = m._top_play.mode;
                if (typeof mode === 'number') mode = modeIdMap[mode] || 'osu';
                if (mode && modeCounts[mode] !== undefined) modeCounts[mode]++;
            }
        });
        
        document.getElementById('stat-total').textContent = totalMaps;
        document.getElementById('stat-downloaded').textContent = downloadedCount;
        
        let modeText = [];
        if (modeCounts.osu > 0) modeText.push(`Osu (${modeCounts.osu})`);
        if (modeCounts.taiko > 0) modeText.push(`Taiko (${modeCounts.taiko})`);
        if (modeCounts.fruits > 0) modeText.push(`Catch (${modeCounts.fruits})`);
        if (modeCounts.mania > 0) modeText.push(`Mania (${modeCounts.mania})`);
        
        document.getElementById('stat-modes').textContent = modeText.length > 0 ? modeText.join(', ') : '-';
    }

    indexMaps() {
        const modeIdMap = { 0: 'osu', 1: 'taiko', 2: 'fruits', 3: 'mania' };
        this.mapsById = new Map();
        this.maps.forEach(map => {
            const beatmaps = map.beatmaps || [];
            if (beatmaps.length > 0) {
                map._modes = [...new Set(beatmaps.map(beatmap => beatmap.mode))];
            } else if (map._top_play) {
                let mode = map._top_play.mode;
                if (typeof mode === 'number') mode = modeIdMap[mode] || 'osu';
                map._modes = mode ? [mode] : [];
            } else {
                map._modes = [];
            }
            map._maxStars = beatmaps.length ? Math.max(...beatmaps.map(beatmap => Number(beatmap.difficulty_rating) || 0)) : 0;
            map._bpm = beatmaps.length ? Math.max(...beatmaps.map(beatmap => Number(beatmap.bpm) || 0)) : 0;
            map._searchTitle = String(map.title || '').toLowerCase();
            this.mapsById.set(map.id, map);
        });
    }

    getFilteredAndSorted() {
        const query = this.filterInput.value.toLowerCase();
        let filtered = this.beatmapsets.filter(s => {
            const text = `${s.title} ${s.artist} ${s.tags}`.toLowerCase();
            return text.includes(query);
        });
        
        if (!this.showDownloadedCb.checked) {
            filtered = filtered.filter(s => !this.downloadedIds.has(s.id));
        }
        
        const sort = this.sortSelect.value;
        filtered.sort((a, b) => {
            if (sort === 'date-desc') return (b.submitted_date || b.ranked_date || '').localeCompare(a.submitted_date || a.ranked_date || '');
            if (sort === 'date-asc') return (a.submitted_date || a.ranked_date || '').localeCompare(b.submitted_date || b.ranked_date || '');
            if (sort === 'stars-desc') return b._maxStars - a._maxStars;
            if (sort === 'stars-asc') return a._maxStars - b._maxStars;
            if (sort === 'bpm-desc') return b._bpm - a._bpm;
            if (sort === 'bpm-asc') return a._bpm - b._bpm;
            if (sort === 'title-asc') return a._searchTitle.localeCompare(b._searchTitle);
            if (sort === 'title-desc') return b._searchTitle.localeCompare(a._searchTitle);
            if (sort === 'favs-desc') return (b.favourite_count || 0) - (a.favourite_count || 0);
            // Top-play-specific sorts
            if (sort === 'pp-desc') return ((b._top_play?.pp || 0) - (a._top_play?.pp || 0));
            if (sort === 'pp-asc') return ((a._top_play?.pp || 0) - (b._top_play?.pp || 0));
            if (sort === 'acc-desc') return ((b._top_play?.accuracy || 0) - (a._top_play?.accuracy || 0));
            if (sort === 'acc-asc') return ((a._top_play?.accuracy || 0) - (b._top_play?.accuracy || 0));
            if (sort === 'misses-asc') return ((a._top_play?.misses ?? 999) - (b._top_play?.misses ?? 999));
            if (sort === 'misses-desc') return ((b._top_play?.misses ?? 0) - (a._top_play?.misses ?? 0));
            if (sort === 'rank-asc') return ((a._top_play?.rank || 999) - (b._top_play?.rank || 999));
            return 0;
        });
        
        return filtered;
    }
    
    getMaxStars(set) {
        return set._maxStars ?? (set.beatmaps?.length ? Math.max(...set.beatmaps.map(b => b.difficulty_rating)) : 0);
    }
    
    getBPM(set) {
        return set._bpm ?? (set.beatmaps?.length ? Math.max(...set.beatmaps.map(b => b.bpm)) : 0);
    }
    
    getModeString(set) {
        const modeIdMap = { 0: 'osu', 1: 'taiko', 2: 'fruits', 3: 'mania' };
        let mode;
        if (set.beatmaps && set.beatmaps.length > 0) {
            const modes = new Set(set.beatmaps.map(b => b.mode));
            if (modes.size > 1) return 'Mixed';
            mode = Array.from(modes)[0];
        } else if (set._top_play) {
            mode = set._top_play.mode;
            if (typeof mode === 'number') mode = modeIdMap[mode] || '';
        }
        if (!mode) return '';
        
        if (mode === 'osu') return 'osu!';
        if (mode === 'taiko') return 'Taiko';
        if (mode === 'fruits') return 'Catch';
        if (mode === 'mania') {
            if (set.beatmaps && set.beatmaps.length > 0) {
                const keys = new Set(set.beatmaps.map(b => b.cs));
                if (keys.size === 1) return `Mania ${Array.from(keys)[0]}K`;
            }
            return 'Mania';
        }
        return mode;
    }
    
    formatDate(ds) {
        if (!ds) return '-';
        return ds.split('T')[0];
    }
    
    showImageTooltip(id) {
        this.tooltipImg.src = `https://assets.ppy.sh/beatmaps/${id}/covers/cover.jpg`;
        this.tooltip.style.display = 'block';
    }
    
    hideImageTooltip() {
        this.tooltip.style.display = 'none';
        this.tooltipImg.src = '';
    }
    
    selectAll() {
        const rows = document.querySelectorAll('.data-table tbody tr');
        rows.forEach(tr => {
            const id = parseInt(tr.id.replace('row-', ''));
            const cb = tr.querySelector('input[type="checkbox"]');
            if (cb && !cb.disabled && !this.selectedIds.has(id)) {
                this.selectedIds.add(id);
                cb.checked = true;
                tr.classList.add('selected');
            }
        });
        
        const cards = document.querySelectorAll('.thumb-cell');
        cards.forEach(card => {
            const id = parseInt(card.id.replace('grid-', ''));
            if (!this.selectedIds.has(id) && !this.downloadedIds.has(id)) {
                this.selectedIds.add(id);
                card.classList.add('selected');
                const cb = card.querySelector('input[type="checkbox"]');
                if (cb) cb.checked = true;
            }
        });
        
        this.updateSidebar();
    }
    
    selectAllRanked() {
        const rows = document.querySelectorAll('.data-table tbody tr');
        rows.forEach(tr => {
            const id = parseInt(tr.id.replace('row-', ''));
            const statBadge = tr.querySelector('.status-badge');
            const isRanked = statBadge && (statBadge.textContent === 'ranked' || statBadge.textContent === 'approved');
            const cb = tr.querySelector('input[type="checkbox"]');
            if (cb && !cb.disabled && isRanked && !this.selectedIds.has(id)) {
                this.selectedIds.add(id);
                cb.checked = true;
                tr.classList.add('selected');
            }
        });
        
        const cards = document.querySelectorAll('.thumb-cell');
        cards.forEach(card => {
            const id = parseInt(card.id.replace('grid-', ''));
            const map = this.mapsById.get(id);
            if (map && (map._type === 'ranked' || map._type === 'approved')) {
                if (!this.selectedIds.has(id) && !this.downloadedIds.has(id)) {
                    this.selectedIds.add(id);
                    card.classList.add('selected');
                    const cb = card.querySelector('input[type="checkbox"]');
                    if (cb) cb.checked = true;
                }
            }
        });
        
        this.updateSidebar();
    }
    
    selectAllUndownloaded() {
        const rows = document.querySelectorAll('.data-table tbody tr');
        rows.forEach(tr => {
            const id = parseInt(tr.id.replace('row-', ''));
            const cb = tr.querySelector('input[type="checkbox"]');
            if (cb && !cb.disabled && !this.downloadedIds.has(id) && !this.selectedIds.has(id)) {
                this.selectedIds.add(id);
                cb.checked = true;
                tr.classList.add('selected');
            }
        });
        
        const cards = document.querySelectorAll('.thumb-cell');
        cards.forEach(card => {
            const id = parseInt(card.id.replace('grid-', ''));
            if (!this.downloadedIds.has(id) && !this.selectedIds.has(id)) {
                this.selectedIds.add(id);
                card.classList.add('selected');
                const cb = card.querySelector('input[type="checkbox"]');
                if (cb) cb.checked = true;
            }
        });
        
        this.updateSidebar();
    }

    selectNone() {
        this.selectedIds.clear();
        this.render();
    }
    
    selectTopN(n) {
        this.selectedIds.clear();
        const sorted = [...this.maps].filter(m => m._top_play).sort((a, b) => a._top_play.rank - b._top_play.rank);
        sorted.slice(0, n).forEach(m => {
            if (!this.downloadedIds.has(m.id)) {
                this.selectedIds.add(m.id);
            }
        });
        this.render();
        this.logConsole(`Selected top ${n} undownloaded plays.`, 'ok');
    }
    
    toggleViewMode() {
        const radios = document.getElementsByName('view-mode');
        let selected = 'table';
        for (let r of radios) {
            if (r.checked) {
                selected = r.value;
                break;
            }
        }
        
        this.viewMode = selected;
        if (this.viewMode === 'table') {
            this.tableWrapper.style.display = 'block';
            this.gridWrapper.style.display = 'none';
        } else {
            this.tableWrapper.style.display = 'none';
            this.gridWrapper.style.display = 'block';
        }
    }
    
    render() {
        const maps = this.getFilteredAndSorted();
        
        // Update result counter
        const counter = document.getElementById('result-counter');
        if (counter) {
            const total = this.maps.length;
            if (maps.length < total) {
                counter.textContent = `Showing ${maps.length} of ${total} maps`;
                counter.style.display = 'block';
            } else if (total > 0) {
                counter.textContent = `Showing all ${total} maps`;
                counter.style.display = 'block';
            } else {
                counter.style.display = 'none';
            }
        }
        
        if (this.viewMode === 'table') {
            const hStars = document.getElementById('header-stars');
            const hBpm = document.getElementById('header-bpm');
            if (hStars && hBpm) {
                if (this.searchMode === 'topplays') {
                    hStars.textContent = 'PP';
                    hBpm.textContent = 'Acc';
                } else {
                    hStars.textContent = 'Stars';
                    hBpm.textContent = 'BPM';
                }
            }
            this.tableWrapper.style.display = 'block';
            this.gridWrapper.style.display = 'none';
            this.gridContainer.innerHTML = '';
            this.renderTable(maps);
        } else {
            this.tableWrapper.style.display = 'none';
            this.gridWrapper.style.display = 'block';
            this.tbody.innerHTML = '';
            this.renderGrid(maps);
        }
        
        this.updateSidebar();
    }
    
    renderTable(maps) {
        this.tbody.innerHTML = '';
        if (maps.length === 0) {
            this.tbody.innerHTML = `<tr><td colspan="8" align="center">No matches found.</td></tr>`;
            return;
        }
        
        const df = document.createDocumentFragment();
        
        maps.forEach(s => {
            const tr = document.createElement('tr');
            const topPlay = s._top_play;
            const isDl = this.downloadedIds.has(s.id);
            const isSel = this.selectedIds.has(s.id);
            const isFail = this.failedIds.has(s.id);
            
            if (isDl) tr.classList.add('already-downloaded');
            if (isSel) tr.classList.add('selected');
            if (isFail) tr.classList.add('failed');
            
            tr.id = `row-${s.id}`;
            
            const tdCb = document.createElement('td');
            tdCb.align = 'center';
            if (isDl) {
                tdCb.innerHTML = `&check;`;
            } else {
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.checked = isSel;
                cb.addEventListener('change', (e) => this.toggleSelection(s.id, e.target.checked));
                tdCb.appendChild(cb);
            }
            
            const tdId = document.createElement('td');
            tdId.innerHTML = `<a href="https://osu.ppy.sh/beatmapsets/${s.id}" target="_blank">${s.id}</a>`;
            
            const tdStat = document.createElement('td');
            tdStat.innerHTML = topPlay
                ? `<span class="status-badge">#${topPlay.rank} ${(topPlay.mods || []).map(escapeHtml).join(' ') || 'NM'}</span>`
                : `<span class="status-badge status-${(s._type || '').toLowerCase()}">${escapeHtml(s._type)}</span>`;
            
            const tdTitle = document.createElement('td');
            
            const playBtn = document.createElement('div');
            playBtn.className = `play-btn play-btn-${s.id}`;
            playBtn.innerHTML = '&#9658;';
            if (this.currentAudioId === s.id) playBtn.classList.add('playing');
            playBtn.onclick = () => this.toggleAudio(s.id);
            
            let titleText = `<strong>${escapeHtml(s.artist)}</strong> - ${escapeHtml(s.title)}`;
            if (topPlay) titleText += ` <small>[${escapeHtml(topPlay.difficulty)} • ${escapeHtml(topPlay.grade)} • ${topPlay.max_combo}x • ${topPlay.misses} miss]</small>`;
            const titleLink = document.createElement('span');
            titleLink.innerHTML = `<a href="https://osu.ppy.sh/beatmapsets/${s.id}" target="_blank" rel="noopener" style="color:inherit;text-decoration:none;">${titleText}</a>`;
            titleLink.addEventListener('mouseenter', () => this.showImageTooltip(s.id));
            titleLink.addEventListener('mouseleave', () => this.hideImageTooltip());
            
            tdTitle.appendChild(playBtn);
            tdTitle.appendChild(titleLink);
            
            const tdMode = document.createElement('td');
            tdMode.textContent = this.getModeString(s);
            
            const tdStars = document.createElement('td');
            tdStars.textContent = topPlay && topPlay.pp != null ? `${Math.round(topPlay.pp)}pp` : this.getMaxStars(s).toFixed(2) + ' \u2605';
            
            const tdBpm = document.createElement('td');
            tdBpm.textContent = topPlay && topPlay.accuracy != null ? `${(topPlay.accuracy * 100).toFixed(2)}%` : this.getBPM(s);
            
            const tdDate = document.createElement('td');
            tdDate.textContent = this.formatDate(topPlay?.date || s.submitted_date || s.ranked_date);
            
            const tdAct = document.createElement('td');
            tdAct.id = `act-tbl-${s.id}`;
            const isAct = this.activeQueue.find(q => q.id === s.id);
            if (isAct) {
                tdAct.innerHTML = '<span style="color:#0066cc;">Queued</span>';
            } else if (isFail) {
                tdAct.innerHTML = '<span style="color:#990000;font-weight:bold;">Failed</span>';
            } else if (isDl) {
                tdAct.innerHTML = '<span style="color:#666">✓</span>';
            } else {
                // Quick download button
                const dlBtn = document.createElement('button');
                dlBtn.textContent = '↓';
                dlBtn.title = 'Quick download this map';
                dlBtn.style.cssText = 'cursor:pointer; padding:1px 6px; font-size:12px; border:1px solid #999; background:#eee;';
                dlBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.selectedIds.add(s.id);
                    this.updateSidebar();
                    this.startDownloadQueue();
                });
                tdAct.appendChild(dlBtn);
            }
            
            tr.appendChild(tdCb);
            tr.appendChild(tdId);
            tr.appendChild(tdStat);
            tr.appendChild(tdTitle);
            tr.appendChild(tdMode);
            tr.appendChild(tdStars);
            tr.appendChild(tdBpm);
            tr.appendChild(tdDate);
            tr.appendChild(tdAct);
            
            df.appendChild(tr);
        });
        
        this.tbody.appendChild(df);
    }
    
    renderGrid(maps) {
        this.gridContainer.innerHTML = '';
        if (maps.length === 0) {
            this.gridContainer.innerHTML = `<div>No matches found.</div>`;
            return;
        }
        
        const df = document.createDocumentFragment();
        
        maps.forEach(s => {
            const cell = document.createElement('div');
            const topPlay = s._top_play;
            cell.className = 'thumb-cell';
            
            const isDl = this.downloadedIds.has(s.id);
            const isSel = this.selectedIds.has(s.id);
            
            if (isDl) cell.classList.add('already-downloaded');
            if (isSel) cell.classList.add('selected');
            
            cell.id = `grid-${s.id}`;
            
            const coverUrl = `https://assets.ppy.sh/beatmaps/${s.id}/covers/cover.jpg`;
            
            let cbHtml = '';
            if (isDl) {
                cbHtml = `<span class="dl-badge">&check; DL</span>`;
            } else {
                cbHtml = `<input type="checkbox" ${isSel ? 'checked' : ''} onchange="window.app.toggleSelection(${s.id}, this.checked)">`;
            }
            
            let titleHtml = escapeHtml(s.title);
            
            cell.innerHTML = `
                <div class="thumb-title-bar" title="${escapeHtml(s.title)}">
                    <a href="https://osu.ppy.sh/beatmapsets/${s.id}" target="_blank" rel="noopener" style="color:inherit; text-decoration:none;">${titleHtml}</a>
                </div>
                <div class="thumb-img-container">
                    <img src="${coverUrl}" class="thumb-img" onerror="this.src=''" alt="cover">
                    <div class="play-btn thumb-play-btn play-btn-${s.id} ${this.currentAudioId === s.id ? 'playing' : ''}" onclick="window.app.toggleAudio(${s.id})">&#9658;</div>
                </div>
                <div class="thumb-artist" title="${escapeHtml(s.artist)}">
                    <a href="https://osu.ppy.sh/beatmapsets/${s.id}" target="_blank" rel="noopener" style="color:inherit; text-decoration:none;">${escapeHtml(s.artist)}</a>
                </div>
                <div class="thumb-meta" style="display:flex; justify-content:space-between; margin-bottom:2px; font-size:10px; color:#555;">
                    <span>${this.getModeString(s)}</span>
                    <span>BPM: ${this.getBPM(s)}</span>
                </div>
                <div style="display:flex; justify-content:space-between; margin-bottom:2px;">
                    <span class="status-badge status-${(s._type || '').toLowerCase()}">${topPlay ? `#${topPlay.rank} ${(topPlay.mods || []).join(' ') || 'NM'}` : escapeHtml(s._type)}</span>
                    <span>${topPlay?.pp != null ? `${Math.round(topPlay.pp)}pp` : `${this.getMaxStars(s).toFixed(2)}\u2605`}</span>
                </div>
                <div class="thumb-bottom">
                    ${cbHtml}
                    <div id="act-grd-${s.id}" style="text-align:right;">ID: ${s.id}</div>
                </div>
            `;
            
            df.appendChild(cell);
        });
        
        this.gridContainer.appendChild(df);
    }
    
    toggleSelection(id, isSelected) {
        if (isSelected) {
            this.selectedIds.add(id);
            if (document.getElementById(`row-${id}`)) document.getElementById(`row-${id}`).classList.add('selected');
            if (document.getElementById(`grid-${id}`)) document.getElementById(`grid-${id}`).classList.add('selected');
        } else {
            this.selectedIds.delete(id);
            if (document.getElementById(`row-${id}`)) document.getElementById(`row-${id}`).classList.remove('selected');
            if (document.getElementById(`grid-${id}`)) document.getElementById(`grid-${id}`).classList.remove('selected');
        }
        
        const trCb = document.querySelector(`#row-${id} input[type="checkbox"]`);
        const grdCb = document.querySelector(`#grid-${id} input[type="checkbox"]`);
        if (trCb) trCb.checked = isSelected;
        if (grdCb) grdCb.checked = isSelected;
        
        this.updateSidebar();
    }
    
    updateSidebar() {
        const count = this.selectedIds.size;
        document.getElementById('selected-count').textContent = count;
        
        const btn = document.getElementById('download-btn');
        const retryBtn = document.getElementById('retry-failed-btn');
        const progPanel = document.getElementById('batch-progress-panel');
        
        if (this.failedIds.size > 0 && !this.isDownloading) {
            retryBtn.style.display = 'block';
            retryBtn.textContent = `Retry Failed (${this.failedIds.size})`;
        } else {
            retryBtn.style.display = 'none';
        }

        if (this.isDownloading) {
            btn.disabled = true;
            retryBtn.disabled = true;
            progPanel.style.display = 'block';
        } else {
            btn.disabled = count === 0;
            retryBtn.disabled = false;
            btn.textContent = `Start Queue (${count})`;
            progPanel.style.display = 'none';
        }
    }
    
    updateActCell(id, html) {
        const tblAct = document.getElementById(`act-tbl-${id}`);
        if (tblAct) tblAct.innerHTML = html;
    }

    initQueueDOM() {
        this.queueListEl.innerHTML = '';
        if (this.activeQueue.length === 0) {
            this.queueListEl.innerHTML = `<div style="color:#999; font-style:italic; padding:10px; text-align:center;">Queue is empty</div>`;
            return;
        }

        const df = document.createDocumentFragment();
        this.activeQueue.forEach(item => {
            const div = document.createElement('div');
            div.className = 'queue-item';
            div.id = `q-item-${item.id}`;
            
            // Just initialize with default colors, will update dynamically
            div.innerHTML = `
                <div class="queue-item-title" id="q-title-${item.id}">${item.id} - ${item.text}</div>
                <div class="queue-item-status" id="q-status-${item.id}">PENDING</div>
                <div class="prog-container" style="margin-top:2px; height:6px; width:100%; display:none;" id="q-prog-cont-${item.id}">
                    <div class="prog-fill" id="q-prog-fill-${item.id}" style="width:0%"></div>
                </div>
            `;
            df.appendChild(div);
        });
        this.queueListEl.appendChild(df);
    }
    
    updateQueueItemDOM(id, status, percent) {
        const itemEl = document.getElementById(`q-item-${id}`);
        const titleEl = document.getElementById(`q-title-${id}`);
        const statusEl = document.getElementById(`q-status-${id}`);
        const progCont = document.getElementById(`q-prog-cont-${id}`);
        const progFill = document.getElementById(`q-prog-fill-${id}`);
        
        if (!titleEl) return;
        
        // Handle Active State
        if (status === 'progress' || status.startsWith('trying') || status.startsWith('[')) {
            itemEl.classList.add('active-download');
            // Auto-scroll
            const scrollPos = itemEl.offsetTop - (this.queueListEl.offsetHeight / 2) + 20;
            this.queueListEl.scrollTo({ top: scrollPos, behavior: 'smooth' });
        } else {
            itemEl.classList.remove('active-download');
        }
        
        let color = 'inherit';
        if (status === 'failed') color = '#cc0000';
        if (status === 'done') color = '#009900';
        if (document.body.classList.contains('dark-mode')) {
            if (status === 'failed') color = '#ff6666';
            if (status === 'done') color = '#00ff00';
        }
        
        titleEl.style.color = color;
        
        if (status.includes('%') || status === 'progress') {
            statusEl.textContent = status;
            progCont.style.display = 'block';
            progFill.style.width = `${percent}%`;
        } else {
            statusEl.textContent = status.toUpperCase();
            if (status === 'done' || status === 'failed') {
                progCont.style.display = 'none';
            }
        }
    }
    
    retryAllFailed() {
        this.failedIds.forEach(id => this.selectedIds.add(id));
        this.failedIds.clear();
        this.render();
        this.startDownloadQueue();
    }

    async startDownloadQueue() {
        if (this.selectedIds.size === 0) return;
        this.downloadQueue = Array.from(this.selectedIds);
        
        // Initialize activeQueue
        this.activeQueue = this.downloadQueue.map(id => {
            const map = this.mapsById.get(id);
            return { id: id, status: 'pending', percent: 0, text: map ? map.title : 'Beatmap' };
        });
        
        this.isDownloading = true;
        this.updateSidebar();
        this.initQueueDOM();
        
        this.logConsole(`Starting batch download of ${this.downloadQueue.length} maps...`, "info");
        
        let completed = 0;
        let total = this.downloadQueue.length;
        
        for (let i = 0; i < total; i++) {
            const id = this.downloadQueue[i];
            document.getElementById('batch-count').textContent = `${i+1}/${total}`;
            const fill = document.getElementById('batch-prog-fill');
            if(fill) fill.style.width = `${((i)/total)*100}%`;

            await this.downloadSingle(id, i);
            completed++;
            
            if(fill) fill.style.width = `${((i+1)/total)*100}%`;
        }
        
        this.isDownloading = false;
        this.selectedIds.clear();
        this.render(); 
        this.updateSidebar();
        
        const successCount = completed - this.failedIds.size;
        const failCount = this.failedIds.size;
        this.logConsole(`Batch queue finished. Downloaded ${successCount} items. ${failCount} failed.`, "ok");
        
        // Desktop notification
        this.showToast(`Queue complete! ${successCount} downloaded, ${failCount} failed.`, failCount > 0 ? 'warn' : 'ok');
        if ('Notification' in window && Notification.permission === 'granted') {
            new Notification('osu! Downloader — Queue Complete', {
                body: `${successCount} maps downloaded. ${failCount} failed.`,
            });
        } else if ('Notification' in window && Notification.permission !== 'denied') {
            Notification.requestPermission();
        }
    }
    
    downloadSingle(id, qIndex) {
        return new Promise(resolve => {
            const qItem = this.activeQueue[qIndex];
            qItem.status = 'trying...';
            this.updateQueueItemDOM(id, qItem.status, 0);

            this.updateActCell(id, `<span style="font-weight:bold;">Downloading...</span>`);
            
            const tr = document.getElementById(`row-${id}`);
            if(tr) tr.classList.remove('failed', 'selected');
            
            this.failedIds.delete(id);
            const ev = new EventSource(`/api/download-progress/${id}`);
            
            ev.onmessage = (e) => {
                const data = JSON.parse(e.data);
                
                if (data.type === 'trying') {
                    qItem.status = `[${data.mirror}]`;
                    this.updateQueueItemDOM(id, qItem.status, 0);
                }
                else if (data.type === 'mirror_fail') {
                    this.logConsole(`Map ${id} failed on ${data.mirror}: ${data.reason}`, "warn");
                }
                else if (data.type === 'start') {
                    this.logConsole(`Started downloading ${data.filename}...`, "info");
                }
                else if (data.type === 'progress') {
                    qItem.status = `[${data.mirror}] ${data.percent}%`;
                    qItem.percent = data.percent;
                    this.updateQueueItemDOM(id, qItem.status, qItem.percent);
                    
                    this.updateActCell(id, `<div class="prog-container"><div class="prog-fill" style="width:${data.percent}%"></div><div class="prog-text">${data.percent}%</div></div>`);
                    
                    let mbps = (data.speed / (1024*1024)).toFixed(1);
                    document.getElementById('batch-speed').textContent = `${mbps} MB/s`;
                    
                    if (data.speed > 0) {
                        let rem = (data.total - data.downloaded) / data.speed;
                        document.getElementById('batch-eta').textContent = rem < 60 ? `${Math.round(rem)}s` : `${Math.floor(rem/60)}m`;
                    }
                }
                else if (data.type === 'done') {
                    ev.close();
                    qItem.status = 'done';
                    qItem.percent = 100;
                    this.updateQueueItemDOM(id, qItem.status, 100);
                    
                    this.updateActCell(id, `<span style="color:#009900;font-weight:bold;">Done</span>`);
                    this.downloadedIds.add(id);
                    this.logConsole(`Successfully downloaded ${data.filename} to Songs folder.`, "ok");
                    resolve();
                }
                else if (data.type === 'failed') {
                    ev.close();
                    qItem.status = 'failed';
                    this.updateQueueItemDOM(id, qItem.status, 0);
                    
                    this.updateActCell(id, `<span style="color:#990000;font-weight:bold;">Failed</span>`);
                    if(tr) tr.classList.add('failed');
                    this.failedIds.add(id);
                    resolve();
                }
            };
            
            ev.onerror = () => {
                ev.close();
                qItem.status = 'failed';
                const tr = document.getElementById(`row-${id}`);
                this.updateQueueItemDOM(id, qItem.status, 0);
                
                this.updateActCell(id, `<span style="color:#990000;font-weight:bold;">Lost</span>`);
                if(tr) tr.classList.add('failed');
                this.failedIds.add(id);
                this.logConsole(`Connection interrupted for map ${id}.`, "err");
                resolve();
            };
        });
    }
}

window.app = new App();
