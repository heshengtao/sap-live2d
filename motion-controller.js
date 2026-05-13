// motion-controller.js
(function () {
  'use strict';

  const STORAGE_KEY = 'sap_live2d_motion_settings';

  // 默认设置
  const defaults = {
    idleGroup: '',        // 闲置动作组名
    talkGroup: '',        // 对话动作组名
    idleInterval: 15,     // 闲置动作间隔(秒)
    enabled: true
  };

  let settings = loadSettings();
  let model = null;
  let idleTimer = null;
  let isTalking = false;

  // ---------- 设置存储 ----------
  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return Object.assign({}, defaults, JSON.parse(raw));
    } catch (e) {}
    return Object.assign({}, defaults);
  }

  function saveSettings() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }

  // ---------- 模型动作辅助 ----------
  function getMotionGroups(model) {
    if (!model || !model.internalModel || !model.internalModel.motionManager) return [];
    const groups = model.internalModel.motionManager.groups || {};
    const definitions = model.internalModel.motionManager.definitions || {};
    // 返回所有非空的动作组
    return Object.keys(definitions).filter(g => definitions[g] && definitions[g].length > 0);
  }

  function getMotionGroupDetails() {
    if (!model || !model.internalModel || !model.internalModel.motionManager) return {};
    const definitions = model.internalModel.motionManager.definitions || {};
    return definitions;
  }

  function playRandomMotionFromGroup(groupName, priority = 2) {
    if (!model || !groupName) return false;
    try {
      return model.motion(groupName, undefined, priority); // 随机一个
    } catch (e) {
      console.warn('播放动作失败:', groupName, e);
      return false;
    }
  }

  // ---------- 校验 motion3.json 内容 ----------
  function isValidMotionJson(jsonData) {
    // 必需字段：Version, Meta, Curves (至少有一个曲线)
    if (!jsonData || typeof jsonData !== 'object') return false;
    if (!jsonData.Version || !jsonData.Meta || !Array.isArray(jsonData.Curves)) return false;
    // Meta 中应至少包含 Duration (早期版本可能没有 Loop)
    if (typeof jsonData.Meta.Duration !== 'number') return false;
    return true;
  }

  // ---------- 闲置循环 ----------
  function scheduleIdle() {
    if (!settings.enabled || !settings.idleGroup) return;
    stopIdleLoop();
    idleTimer = setTimeout(() => {
      if (!isTalking && settings.idleGroup) {
        playRandomMotionFromGroup(settings.idleGroup, 1); // 低优先级
      }
      scheduleIdle(); // 循环
    }, settings.idleInterval * 1000);
  }

  function startIdleLoop() {
    stopIdleLoop();
    scheduleIdle();
  }

  function stopIdleLoop() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  // ---------- 对话动作 ----------
  function playTalkMotion() {
    if (!model || !settings.talkGroup) return false;
    isTalking = true;
    const result = playRandomMotionFromGroup(settings.talkGroup, 3); // 强制优先级
    // 动作结束后重置 isTalking（若动作有 onFinish 回调可监停，简化起见用固定时间估算）
    setTimeout(() => { isTalking = false; }, 5000);
    return result;
  }

  // ---------- 导入 motion3.json（增加校验）----------
  function importMotionJSON(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const json = JSON.parse(e.target.result);
        
        // 校验是否为合法动作文件
        if (!isValidMotionJson(json)) {
          alert('所选文件不是有效的 Live2D 动作文件（.motion3.json）！请检查文件内容。');
          return;
        }

        if (!model || !model.internalModel || !model.internalModel.motionManager) {
          alert('模型尚未加载，请先加载模型！');
          return;
        }
        const mgr = model.internalModel.motionManager;
        // Cubism 4 的 motionManager 有 definitions 对象
        if (!mgr.definitions) {
          alert('当前模型不支持动态添加动作！');
          return;
        }
        // 使用文件名作为组名
        const groupName = file.name.replace(/\.motion3\.json$/i, '').replace(/\.json$/i, '') || 'imported';
        // 如果该组已存在则追加，否则新建
        if (!mgr.definitions[groupName]) {
          mgr.definitions[groupName] = [];
        }
        // 创建动作定义对象，存储文件名和原始 JSON（用于后续删除）
        const motionDef = { 
          File: file.name,
          file: null,      // 稍后填充 blob URL
          rawJson: json,   // 保留原始 JSON，便于校验或重建
          created: Date.now()
        };
        
        // 将动作 JSON 转为 Blob URL
        const blob = new Blob([e.target.result], { type: 'application/json' });
        const fakeUrl = URL.createObjectURL(blob);
        motionDef.file = fakeUrl;
        
        mgr.definitions[groupName].push(motionDef);
        // 刷新UI
        refreshGroupSelectors();
        refreshMotionManageList();   // 新增：刷新管理列表
        alert(`动作已导入到分组“${groupName}”`);
      } catch (err) {
        alert('导入失败：' + err.message);
        console.error(err);
      }
    };
    reader.readAsText(file);
  }

  // ---------- 删除动作组或单个动作 ----------
  function deleteMotionGroup(groupName) {
    if (!model || !model.internalModel || !model.internalModel.motionManager) return false;
    const mgr = model.internalModel.motionManager;
    if (!mgr.definitions[groupName]) return false;
    
    // 如果当前正在使用该组作为 idle 或 talk，清除设置
    if (settings.idleGroup === groupName) {
      settings.idleGroup = '';
      saveSettings();
      stopIdleLoop();
    }
    if (settings.talkGroup === groupName) {
      settings.talkGroup = '';
      saveSettings();
    }
    
    // 释放每个动作的 Blob URL
    mgr.definitions[groupName].forEach(motion => {
      if (motion.file && motion.file.startsWith('blob:')) {
        URL.revokeObjectURL(motion.file);
      }
    });
    delete mgr.definitions[groupName];
    refreshGroupSelectors();
    refreshMotionManageList();
    return true;
  }

  function deleteMotionFromGroup(groupName, motionIndex) {
    if (!model || !model.internalModel || !model.internalModel.motionManager) return false;
    const mgr = model.internalModel.motionManager;
    if (!mgr.definitions[groupName] || !mgr.definitions[groupName][motionIndex]) return false;
    
    const motion = mgr.definitions[groupName][motionIndex];
    if (motion.file && motion.file.startsWith('blob:')) {
      URL.revokeObjectURL(motion.file);
    }
    mgr.definitions[groupName].splice(motionIndex, 1);
    if (mgr.definitions[groupName].length === 0) {
      delete mgr.definitions[groupName];
    }
    refreshGroupSelectors();
    refreshMotionManageList();
    return true;
  }

  // ---------- 构建动作管理列表 UI ----------
  function refreshMotionManageList() {
    const container = document.getElementById('motion-manage-list');
    if (!container) return;
    
    const definitions = getMotionGroupDetails();
    const groups = Object.keys(definitions);
    
    if (groups.length === 0) {
      container.innerHTML = '<div style="color:#aaa; text-align:center;">暂无导入的动作组</div>';
      return;
    }
    
    let html = '';
    groups.forEach(groupName => {
      const motions = definitions[groupName];
      html += `<div class="motion-group" data-group="${groupName}">
                <div class="motion-group-header">
                  <strong>📁 ${groupName}</strong>
                  <button class="btn-delete-group" data-group="${groupName}">删除整个组</button>
                </div>`;
      motions.forEach((motion, idx) => {
        const fileName = motion.File || (motion.file ? motion.file.split('/').pop() : `动作${idx+1}`);
        html += `<div class="motion-item" data-group="${groupName}" data-index="${idx}">
                    <span>🎬 ${fileName}</span>
                    <button class="btn-delete-motion" data-group="${groupName}" data-index="${idx}">删除</button>
                  </div>`;
      });
      html += `</div>`;
    });
    container.innerHTML = html;
    
    // 绑定删除事件
    container.querySelectorAll('.btn-delete-group').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const group = btn.getAttribute('data-group');
        if (confirm(`确定要删除整个动作组“${group}”吗？`)) {
          deleteMotionGroup(group);
        }
      });
    });
    container.querySelectorAll('.btn-delete-motion').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const group = btn.getAttribute('data-group');
        const idx = parseInt(btn.getAttribute('data-index'), 10);
        if (confirm(`确定要删除动作“${group} / ${idx+1}”吗？`)) {
          deleteMotionFromGroup(group, idx);
        }
      });
    });
  }

  // ---------- UI 刷新 ----------
  function refreshGroupSelectors() {
    const groups = getMotionGroups(model);
    const idleSelect = document.getElementById('motion-idle-group');
    const talkSelect = document.getElementById('motion-talk-group');
    if (idleSelect) populateSelect(idleSelect, groups, settings.idleGroup);
    if (talkSelect) populateSelect(talkSelect, groups, settings.talkGroup);
  }

  function populateSelect(selectEl, groups, selectedValue) {
    selectEl.innerHTML = '<option value="">-- 不选择 --</option>';
    groups.forEach(g => {
      const opt = document.createElement('option');
      opt.value = g;
      opt.textContent = g;
      if (g === selectedValue) opt.selected = true;
      selectEl.appendChild(opt);
    });
  }

  // ---------- 初始化 ----------
  window.initMotionController = function (live2dModel) {
    model = live2dModel;
    refreshGroupSelectors();
    refreshMotionManageList();   // 刷新管理列表
    if (settings.enabled && settings.idleGroup) {
      startIdleLoop();
    }
  };

  // 暴露给外部（如 SAP 主程序）调用的接口
  window.triggerTalkMotion = playTalkMotion;
  window.getMotionSettings = () => settings;

  // 全局删除函数（供外部调用）
  window.deleteMotionGroup = deleteMotionGroup;
  window.deleteMotionFromGroup = deleteMotionFromGroup;
  window.refreshMotionManageList = refreshMotionManageList;

  // 保存按钮事件绑定（需在页面加载后）
  window.addEventListener('DOMContentLoaded', () => {
    const idleSelect = document.getElementById('motion-idle-group');
    const talkSelect = document.getElementById('motion-talk-group');
    const intervalInput = document.getElementById('motion-idle-interval');
    const enableCheck = document.getElementById('motion-enable');
    const importFile = document.getElementById('motion-import-file');
    const manageBtn = document.getElementById('manage-motion-btn');      // 管理按钮
    const motionManageModal = document.getElementById('motion-manage-modal');
    const closeManageModal = document.getElementById('close-manage-modal');

    if (idleSelect) {
      idleSelect.addEventListener('change', (e) => {
        settings.idleGroup = e.target.value;
        saveSettings();
        startIdleLoop();
      });
    }
    if (talkSelect) {
      talkSelect.addEventListener('change', (e) => {
        settings.talkGroup = e.target.value;
        saveSettings();
      });
    }
    if (intervalInput) {
      intervalInput.value = settings.idleInterval;
      intervalInput.addEventListener('change', (e) => {
        settings.idleInterval = Math.max(5, parseInt(e.target.value) || 15);
        saveSettings();
        startIdleLoop();
      });
    }
    if (enableCheck) {
      enableCheck.checked = settings.enabled;
      enableCheck.addEventListener('change', (e) => {
        settings.enabled = e.target.checked;
        saveSettings();
        if (e.target.checked) startIdleLoop();
        else stopIdleLoop();
      });
    }
    if (importFile) {
      importFile.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) importMotionJSON(file);
        importFile.value = ''; // 允许重复选择同一个文件
      });
    }
    // 动作管理按钮
    if (manageBtn && motionManageModal) {
      manageBtn.addEventListener('click', () => {
        refreshMotionManageList();
        motionManageModal.style.display = 'flex';
      });
      if (closeManageModal) {
        closeManageModal.addEventListener('click', () => {
          motionManageModal.style.display = 'none';
        });
      }
      // 点击遮罩关闭
      const overlay = document.getElementById('manage-overlay');
      if (overlay) {
        overlay.addEventListener('click', () => {
          motionManageModal.style.display = 'none';
        });
      }
    }
  });
})();
