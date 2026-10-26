// admin.js (place this in ROOT directory, NOT public/)
console.log("✅ admin.js loaded");

const fileList = document.getElementById('fileList');
const loading = document.getElementById('loading');
const mergeToolbar = document.getElementById('mergeToolbar');
const mergeOutputNameInput = document.getElementById('mergeOutputName');
const mergeStatus = document.getElementById('mergeStatus');
const btnMerge = document.getElementById('btnMerge');
const selectedCountEl = document.getElementById('selectedCount');
const progressBar = document.getElementById('progressBar');
const progressFill = document.getElementById('progressFill');
const progressText = document.getElementById('progressText');
const optGenerateThumb = document.getElementById('optGenerateThumb');
const optDeleteOriginals = document.getElementById('optDeleteOriginals');

// Upload elements
const fileInput = document.getElementById('fileInput');
const uploadCustomName = document.getElementById('uploadCustomName');
const btnUpload = document.getElementById('btnUpload');
const uploadFileList = document.getElementById('uploadFileList');
const uploadProgressBar = document.getElementById('uploadProgressBar');
const uploadProgressFill = document.getElementById('uploadProgressFill');
const uploadProgressText = document.getElementById('uploadProgressText');
const uploadStatus = document.getElementById('uploadStatus');

// Delete elements
const deleteToolbar = document.getElementById('deleteToolbar');
const deleteCountEl = document.getElementById('deleteCount');
const btnMassDelete = document.getElementById('btnMassDelete');
const btnCancelDelete = document.getElementById('btnCancelDelete');

// Move elements
const moveToolbar = document.getElementById('moveToolbar');
const moveCountEl = document.getElementById('moveCount');
const targetFolderInput = document.getElementById('targetFolderInput');
const btnMove = document.getElementById('btnMove');

console.log("📦 Elements found:", {
  fileList: !!fileList,
  loading: !!loading,
  mergeToolbar: !!mergeToolbar,
  btnMerge: !!btnMerge,
  fileInput: !!fileInput,
  btnUpload: !!btnUpload,
  deleteToolbar: !!deleteToolbar
});

// Socket.IO connection for real-time progress
let socket;
try {
  socket = io();
  console.log("🔌 Socket.IO connected");
  
  socket.on('merge:progress', (data) => {
    updateProgress(data.progress, data.message);
  });

  socket.on('merge:error', (data) => {
    showMergeStatus('error', `✗ ${data.error}`);
    resetMergeUI();
  });
} catch (e) {
  console.error("❌ Socket.IO error:", e);
}

// Global selection + drag state
let selectedFiles = [];
let draggedIndex = null;
let allFiles = []; // full list from backend
let selectedFilesForUpload = [];

function updateMergeToolbarState() {
  selectedCountEl.textContent = selectedFiles.length;
  mergeToolbar.style.display = selectedFiles.length > 0 ? 'block' : 'none';
  btnMerge.disabled = selectedFiles.length < 2;
  moveCountEl.textContent = selectedFiles.length;
  moveToolbar.style.display = selectedFiles.length > 0 ? 'block' : 'none';
  
  // Update delete toolbar
  deleteCountEl.textContent = selectedFiles.length;
  deleteToolbar.style.display = selectedFiles.length > 0 ? 'block' : 'none';
  btnMassDelete.disabled = selectedFiles.length === 0;
}

function updateProgress(percent, message) {
  progressBar.style.display = 'block';
  progressText.style.display = 'block';
  progressFill.style.width = percent + '%';
  progressText.textContent = message;
}

function resetMergeUI() {
  btnMerge.disabled = false;
  btnMerge.textContent = 'Merge Selected';
  progressBar.style.display = 'none';
  progressText.style.display = 'none';
  progressFill.style.width = '0%';
}

function resetUploadUI() {
  btnUpload.disabled = true;
  btnUpload.textContent = 'Upload';
  uploadProgressBar.style.display = 'none';
  uploadProgressText.style.display = 'none';
  uploadProgressFill.style.width = '0%';
}

// ---------- Upload ----------

fileInput.addEventListener('change', (e) => {
  selectedFilesForUpload = Array.from(e.target.files);
  console.log("📁 Files selected for upload:", selectedFilesForUpload.length);

  if (selectedFilesForUpload.length > 0) {

    uploadFileList.innerHTML =
      '<div style="margin-top:8px;"><strong>Selected files:</strong></div>';

    selectedFilesForUpload.forEach((file, idx) => {
      const fileItem = document.createElement('div');
      fileItem.className = 'upload-file-item';
      fileItem.textContent =
        `${idx + 1}. ${file.name} ` +
        `(${(file.size / 1024 / 1024 / 1024).toFixed(2)} GB)`;

      uploadFileList.appendChild(fileItem);
    });

    btnUpload.disabled = false;

  } else {
    btnUpload.disabled = true;
    uploadFileList.innerHTML = '';
  }

});

async function uploadFiles() {
  if (selectedFilesForUpload.length === 0) return;
  
  btnUpload.disabled = true;
  btnUpload.textContent = 'Uploading...';
  uploadStatus.innerHTML = '';
  uploadProgressBar.style.display = 'block';
  uploadProgressText.style.display = 'block';
  
  const formData = new FormData();
  
  // Add all selected files
  selectedFilesForUpload.forEach(file => {
    formData.append('videos', file);
  });
  
  // Add custom name if provided (only works for single file)
  const customName = uploadCustomName.value.trim();
  if (customName && selectedFilesForUpload.length === 1) {
    formData.append('customName', customName);
  }
  
  formData.append('generateThumb', 'true');
  
  try {
    const xhr = new XMLHttpRequest();
    
    // Track upload progress
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        const percentComplete = (e.loaded / e.total) * 100;
        uploadProgressFill.style.width = percentComplete + '%';
        uploadProgressText.textContent = `Uploading: ${Math.round(percentComplete)}%`;
      }
    });
    
    // Handle completion
    xhr.addEventListener('load', () => {
      if (xhr.status === 200) {
        let data;
    try {
       data = JSON.parse(xhr.responseText);
    } catch (e) {
    throw new Error("Server returned invalid response (likely 502)");
    }
        
        if (data.success) {
          uploadStatus.innerHTML = `<span class="status success">✓ Uploaded ${data.count} file(s) successfully!</span>`;
          
          // Reset form
          fileInput.value = '';
          uploadCustomName.value = '';
          selectedFilesForUpload = [];
          uploadFileList.innerHTML = '';
          
          // Reload file list
          setTimeout(() => {
            loadFiles();
            resetUploadUI();
            uploadStatus.innerHTML = '';
          }, 2000);
        } else {
          throw new Error(data.error || 'Upload failed');
        }
      } else {
        const data = JSON.parse(xhr.responseText);
        throw new Error(data.error || 'Upload failed');
      }
    });
    
    xhr.addEventListener('error', () => {
      uploadStatus.innerHTML = `<span class="status error">✗ Upload failed</span>`;
      resetUploadUI();
    });
    
    xhr.open('POST', '/api/admin/upload');
    xhr.send(formData);
    
  } catch (err) {
    console.error('Upload error:', err);
    uploadStatus.innerHTML = `<span class="status error">✗ ${err.message}</span>`;
    resetUploadUI();
  }
}

btnUpload.addEventListener('click', uploadFiles);

// ---------- Mass Delete ----------

async function massDelete() {
  if (selectedFiles.length === 0) return;
  
  const confirmMsg = `⚠️ Delete ${selectedFiles.length} file(s)?\n\n${selectedFiles.join('\n')}\n\nThis will remove the videos and thumbnails permanently.`;
  
  if (!confirm(confirmMsg)) {
    return;
  }
  
  btnMassDelete.disabled = true;
  btnMassDelete.textContent = 'Deleting...';
  
  try {
    const res = await fetch('/api/admin/delete', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: selectedFiles })
    });
    
    const data = await res.json();
    
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Delete failed');
    }
    
    // Show results
    let resultMsg = `✓ Deleted ${data.deletedCount} file(s)`;
    if (data.failedCount > 0) {
      resultMsg += ` • ${data.failedCount} failed`;
    }
    
    alert(resultMsg);
    
    // Remove deleted files from allFiles
    allFiles = allFiles.filter(f => !data.deleted.includes(f.filename));
    
    // Clear selection
    clearSelection();
    
    // Re-render
    renderFileList();
    
  } catch (err) {
    console.error('Mass delete error:', err);
    alert(`❌ Delete failed: ${err.message}`);
  } finally {
    btnMassDelete.disabled = false;
    btnMassDelete.textContent = 'Delete Selected';
  }
}

function cancelDelete() {
  clearSelection();
}

btnMassDelete.addEventListener('click', massDelete);
btnCancelDelete.addEventListener('click', cancelDelete);

// ---------- Selection ----------

function toggleSelection(filename, checked) {
  if (checked) {
    if (!selectedFiles.includes(filename)) {
      selectedFiles.push(filename);
    }
  } else {
    selectedFiles = selectedFiles.filter(f => f !== filename);
  }
  console.log("🧪 FRONTEND selectedFiles after toggle:", selectedFiles);
  updateMergeToolbarState();
  renderFileList(); // re-render to update badges & draggable state
}

function clearSelection() {
  selectedFiles = [];
  console.log("🧪 FRONTEND selectedFiles after clear:", selectedFiles);
  updateMergeToolbarState();
  mergeStatus.innerHTML = '';
  renderFileList();
}

// ---------- Drag & Drop ----------

function handleDragStart(e) {
  const filename = e.currentTarget.dataset.filename;
  draggedIndex = selectedFiles.indexOf(filename);
  e.currentTarget.style.opacity = '0.4';
  e.dataTransfer.effectAllowed = 'move';
}

function handleDragOver(e) {
  if (e.preventDefault) e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  return false;
}

function handleDrop(e) {
  if (e.stopPropagation) e.stopPropagation();
  
  const filename = e.currentTarget.dataset.filename;
  const dropIndex = selectedFiles.indexOf(filename);
  
  if (draggedIndex !== null && draggedIndex !== dropIndex) {
    const [draggedItem] = selectedFiles.splice(draggedIndex, 1);
    selectedFiles.splice(dropIndex, 0, draggedItem);
    console.log("🧪 FRONTEND selectedFiles after drag:", selectedFiles);
    renderFileList();
  }
  
  return false;
}

function handleDragEnd(e) {
  e.currentTarget.style.opacity = '1';
  draggedIndex = null;
}

// ---------- Backend: load files ----------

async function loadFiles() {
  console.log("🔄 loadFiles() called");
  try {
    console.log("📡 Fetching /api/admin/files...");
    const res = await fetch('/api/admin/files');
    console.log("📡 Response status:", res.status);
    
    if (!res.ok) throw new Error('Failed to fetch files');
    allFiles = await res.json();
    console.log("📁 Files received:", allFiles.length, allFiles);

    loading.style.display = 'none';
    fileList.style.display = 'flex';

    selectedFiles = [];
    updateMergeToolbarState();
    mergeStatus.innerHTML = '';

    renderFileList();
    
    console.log("✅ All items added to DOM");
  } catch (err) {
    console.error("❌ Load error:", err);
    loading.textContent = `Error: ${err.message}`;
  }
}

// ---------- Rendering ----------

function renderFileList() {
  console.log("🎨 renderFileList called. selectedFiles:", selectedFiles);
  fileList.innerHTML = '';

  if (!allFiles.length) {
    fileList.innerHTML = '<div style="color:var(--muted);text-align:center;padding:40px;">No video files found.</div>';
    return;
  }

  allFiles.forEach((file) => {
    const isSelected = selectedFiles.includes(file.filename);
    const selectedIndex = selectedFiles.indexOf(file.filename);
    
    const item = document.createElement('div');
    item.className = 'file-item' + (isSelected ? ' selected' : '');
    item.dataset.filename = file.filename;
    
    if (isSelected) {
      item.draggable = true;
      item.style.cursor = 'grab';
      item.addEventListener('dragstart', handleDragStart);
      item.addEventListener('dragover', handleDragOver);
      item.addEventListener('drop', handleDrop);
      item.addEventListener('dragend', handleDragEnd);
    }

    item.innerHTML = `
      <input
        type="checkbox"
        class="select-checkbox"
        style="accent-color:#ef4444;width:18px;height:18px;cursor:pointer;"
        data-filename="${file.filename}"
        ${isSelected ? 'checked' : ''}
      />
      <div class="thumb-preview" style="background-image:url('${file.thumbPath || ''}');"></div>
      <div class="file-info">
        <div class="current-name">
          ${file.filename}
          ${isSelected ? `<span class="select-badge">#${selectedIndex + 1}</span>` : ''}
        </div>
        <div class="file-meta">
          ${file.hasThumbnail ? '✓ Has thumbnail' : '⚠ No thumbnail'}
          ${isSelected ? ' • <span style="color:#ef4444;">⇅ Drag to reorder</span>' : ''}
        </div>
        <div class="rename-section" style="margin-top:12px;display:flex;gap:8px;align-items:center;">
          <input 
            type="text" 
            class="rename-input" 
            value="${file.basename}"
            placeholder="New filename (without .mp4)"
            data-original="${file.filename}"
            style="flex:1;"
          />
          <button class="btn-rename" style="padding:8px 16px;background:#22c55e;color:#000;border:none;border-radius:6px;cursor:pointer;font-weight:600;">Rename</button>
          <button class="btn-delete" style="padding:8px 16px;background:#ef4444;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:600;">🗑️ Delete</button>
        </div>
        <div class="status-msg" style="margin-top:8px;min-height:20px;"></div>
      </div>
    `;

    const checkbox = item.querySelector('.select-checkbox');
    checkbox.addEventListener('change', (e) => {
      e.stopPropagation();
      const fname = e.target.dataset.filename;
      console.log("☑️ Checkbox changed:", fname, e.target.checked);
      toggleSelection(fname, e.target.checked);
    });

    const renameBtn = item.querySelector('.btn-rename');
    renameBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      renameFile(renameBtn);
    });

    // 🗑️ Delete button handler
    const deleteBtn = item.querySelector('.btn-delete');
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteFile(deleteBtn);
    });

    const renameInput = item.querySelector('.rename-input');
    renameInput.addEventListener('mousedown', (e) => {
      e.stopPropagation();
    });

    fileList.appendChild(item);
  });
}

// ---------- Rename ----------

async function renameFile(btn) {
  const item = btn.closest('.file-item');
  const input = item.querySelector('.rename-input');
  const statusMsg = item.querySelector('.status-msg');
  const oldName = input.dataset.original;
  const newName = input.value.trim();

  if (!newName) {
    showStatus(statusMsg, 'error', 'Filename cannot be empty');
    return;
  }

  if (newName === oldName.replace('.mp4', '')) {
    showStatus(statusMsg, 'error', 'New name is the same as current name');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Renaming...';
  statusMsg.innerHTML = '';

  try {
    const res = await fetch('/api/admin/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldName, newName })
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || 'Rename failed');
    }

    showStatus(statusMsg, 'success', '✓ Renamed successfully!');
    input.dataset.original = data.newFilename;

    // Refresh list to update filename / basename consistently
    setTimeout(() => loadFiles(), 1000);
  } catch (err) {
    showStatus(statusMsg, 'error', `✗ ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Rename';
  }
}

// ---------- Delete ----------

async function deleteFile(btn) {
  const item = btn.closest('.file-item');
  const filename = item.dataset.filename || item.querySelector('.select-checkbox')?.dataset.filename;
  
  if (!filename) {
    alert('Could not determine filename');
    return;
  }

  if (!confirm(`⚠️ Delete ${filename}?\n\nThis will remove the video and thumbnail permanently.`)) {
    return;
  }

  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = 'Deleting...';

  try {
    const res = await fetch('/api/admin/delete', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: [filename] })
    });

    const data = await res.json();

    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Delete failed');
    }

    // Remove from allFiles array
    allFiles = allFiles.filter(f => f.filename !== filename);
    
    // Remove from selection if selected
    selectedFiles = selectedFiles.filter(f => f !== filename);
    updateMergeToolbarState();
    
    // Re-render the list
    renderFileList();
    
    console.log(`✅ Deleted: ${filename}`);
    
  } catch (err) {
    alert(`❌ Delete failed: ${err.message}`);
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

// ---------- Status helpers ----------

function showStatus(element, type, message) {
  element.innerHTML = `<span class="status ${type}">${message}</span>`;
  if (type === 'success') {
    setTimeout(() => { element.innerHTML = ''; }, 3000);
  }
}

function showMergeStatus(type, message) {
  mergeStatus.innerHTML = `<span class="status ${type}">${message}</span>`;
  if (type === 'success') {
    setTimeout(() => { mergeStatus.innerHTML = ''; }, 5000);
  }
}

// ---------- Merge ----------

async function mergeSelected() {
  if (selectedFiles.length < 2) return;

  console.log("🧪 FRONTEND mergeSelected files order:", selectedFiles);

  btnMerge.disabled = true;
  btnMerge.textContent = 'Merging...';
  mergeStatus.innerHTML = '';
  updateProgress(0, 'Starting merge...');

  const outputName = mergeOutputNameInput.value.trim();
  const generateThumb = optGenerateThumb.checked;
  const deleteOriginals = optDeleteOriginals.checked;

  try {
    const res = await fetch('/api/admin/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: selectedFiles,
        outputName: outputName || undefined,
        generateThumb,
        deleteOriginals
      })
    });

    const data = await res.json();

    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Merge failed');
    }

    let successMsg = `✓ Merged to <code style="font-family:monospace;background:rgba(255,255,255,0.1);padding:2px 6px;border-radius:3px;">${data.mergedFilename}</code>`;
    
    if (data.thumbnailGenerated) {
      successMsg += ' • Thumbnail created';
    }
    
    if (data.deletedFiles && data.deletedFiles.length > 0) {
      successMsg += ` • Deleted ${data.deletedFiles.length} original files`;
    }

    showMergeStatus('success', successMsg);
    updateProgress(100, 'Complete!');

    setTimeout(() => {
      mergeOutputNameInput.value = '';
      clearSelection();
      loadFiles();
      resetMergeUI();
    }, 2000);
  } catch (err) {
    console.error(err);
    showMergeStatus('error', `✗ ${err.message}`);
    resetMergeUI();
  }
}

// Move

async function moveSelected() {
  const targetFolder = targetFolderInput.value.trim();
  if (selectedFiles.length === 0 || !targetFolder) {
    alert('Please select files and enter a folder name.');
    return;
  }

  btnMove.disabled = true;
  btnMove.textContent = 'Moving...';

  try {
    const res = await fetch('/api/admin/move', { // Assuming merge.js is mounted at /api/admin
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: selectedFiles, targetFolder })
    });
    
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error);

    alert(`✓ Moved ${data.moved.length} files to "${data.folder}"`);
    clearSelection();
    targetFolderInput.value = '';
    loadFiles(); // Refresh list
  } catch (err) {
    alert(`❌ Move failed: ${err.message}`);
  } finally {
    btnMove.disabled = false;
    btnMove.textContent = '📁 Move Selected';
  }
}
if(btnMove) btnMove.addEventListener('click', moveSelected);

// ---------- Init ----------

console.log("⏳ Setting up DOMContentLoaded listener...");
document.addEventListener('DOMContentLoaded', () => {
  console.log("🚀 DOMContentLoaded fired!");
  loadFiles();
  
  if (btnMerge) {
    btnMerge.addEventListener('click', mergeSelected);
    console.log("✅ Merge button listener attached");
  }
  
  const btnClear = document.getElementById('btnClear');
  if (btnClear) {
    btnClear.addEventListener('click', clearSelection);
    console.log("✅ Clear button listener attached");
  }
});

