const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const { createReadStream } = require('fs');

let mainWindow;
let state = {
  paused: false,
  currentIndex: 0,
  deduplicationMap: new Map(),
  fileList: [],
  folderList: [],
  folderMap: new Map(),
  copiedFolders: new Set(),
  folderReport: [],
  stats: {
    scanned: 0,
    copied: 0,
    duplicates: 0,
    sizeCopied: 0
  }
};

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.loadFile('index.html');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

function normalizeFolderName(folderName) {
  const underscoreIndex = folderName.indexOf('_');
  if (underscoreIndex !== -1) {
    return folderName.substring(0, underscoreIndex);
  }
  return folderName;
}

async function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = createReadStream(filePath);
    
    stream.on('data', (data) => {
      if (!state.paused) {
        hash.update(data);
      }
    });
    
    stream.on('end', () => {
      if (!state.paused) {
        resolve(hash.digest('hex'));
      } else {
        reject(new Error('Paused'));
      }
    });
    
    stream.on('error', reject);
  });
}

async function scanDirectory(dirPath, fileList, folderList, allowedExtensions, relativePath = '', sourceRoot = '') {
  try {
    if (!sourceRoot) {
      sourceRoot = dirPath;
    }
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const folderFiles = [];
    const subFolders = [];
    let hasSubDirectories = false;
    
    for (const entry of entries) {
      if (state.paused) break;
      
      const fullPath = path.join(dirPath, entry.name);
      const relPath = relativePath ? path.join(relativePath, entry.name) : entry.name;
      const relativeFromRoot = path.relative(sourceRoot, fullPath);
      
      try {
        if (entry.isDirectory()) {
          hasSubDirectories = true;
          subFolders.push({ path: fullPath, relativePath: relPath });
          await scanDirectory(fullPath, fileList, folderList, allowedExtensions, relPath, sourceRoot);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase().slice(1);
          if (allowedExtensions.length === 0 || allowedExtensions.includes(ext)) {
            const stats = await fs.stat(fullPath);
            const fileInfo = {
              path: fullPath,
              size: stats.size,
              name: entry.name,
              relativePath: relativeFromRoot,
              folderPath: dirPath,
              folderRelativePath: path.dirname(relativeFromRoot)
            };
            fileList.push(fileInfo);
            folderFiles.push(fileInfo);
          }
        }
      } catch (err) {
        continue;
      }
    }
    
    if (folderFiles.length > 0 || subFolders.length > 0) {
      folderList.push({
        path: dirPath,
        relativePath: relativePath || path.basename(dirPath),
        files: folderFiles,
        subFolders: subFolders.map(sf => sf.relativePath),
        isLeaf: !hasSubDirectories
      });
    }
  } catch (err) {
    return;
  }
}

async function buildFolderSignature(folderInfo, allowedExtensions) {
  const fileHashes = [];
  
  for (const file of folderInfo.files) {
    if (state.paused) break;
    try {
      const hash = await hashFile(file.path);
      fileHashes.push({
        name: file.name,
        size: file.size,
        hash: hash
      });
    } catch (err) {
      continue;
    }
  }
  
  fileHashes.sort((a, b) => a.name.localeCompare(b.name));
  
  const signature = crypto.createHash('sha256');
  for (const fh of fileHashes) {
    signature.update(`${fh.name}:${fh.size}:${fh.hash}`);
  }
  
  return {
    hash: signature.digest('hex'),
    fileCount: fileHashes.length,
    totalSize: folderInfo.files.reduce((sum, f) => sum + f.size, 0),
    files: fileHashes
  };
}

async function copyFolderRecursive(sourcePath, destPath) {
  try {
    await fs.mkdir(destPath, { recursive: true });
    const entries = await fs.readdir(sourcePath, { withFileTypes: true });
    
    for (const entry of entries) {
      if (state.paused) break;
      
      const sourceEntry = path.join(sourcePath, entry.name);
      const destEntry = path.join(destPath, entry.name);
      
      try {
        if (entry.isDirectory()) {
          await copyFolderRecursive(sourceEntry, destEntry);
        } else if (entry.isFile()) {
          await fs.copyFile(sourceEntry, destEntry);
        }
      } catch (err) {
        continue;
      }
    }
  } catch (err) {
    throw err;
  }
}

async function mergeFolderRecursive(sourcePath, destPath, fileHashMap) {
  try {
    await fs.mkdir(destPath, { recursive: true });
    const entries = await fs.readdir(sourcePath, { withFileTypes: true });
    
    for (const entry of entries) {
      if (state.paused) break;
      
      const sourceEntry = path.join(sourcePath, entry.name);
      const destEntry = path.join(destPath, entry.name);
      
      try {
        if (entry.isDirectory()) {
          await mergeFolderRecursive(sourceEntry, destEntry, fileHashMap);
        } else if (entry.isFile()) {
          try {
            const stats = await fs.stat(sourceEntry);
            const hash = await hashFile(sourceEntry);
            const key = `${stats.size}:${hash}`;
            
            if (!fileHashMap.has(key)) {
              await fs.copyFile(sourceEntry, destEntry);
              fileHashMap.set(key, true);
            }
          } catch (err) {
            continue;
          }
        }
      } catch (err) {
        continue;
      }
    }
  } catch (err) {
    throw err;
  }
}

async function scanDestinationFolder(dirPath, allowedExtensions, relativePath = '') {
  const folderInfo = {
    path: dirPath,
    relativePath: relativePath || path.basename(dirPath),
    files: [],
    subFolders: []
  };
  
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    
    for (const entry of entries) {
      if (state.paused) break;
      
      const fullPath = path.join(dirPath, entry.name);
      const relPath = path.join(relativePath, entry.name);
      
      try {
        if (entry.isDirectory()) {
          const subFolder = await scanDestinationFolder(fullPath, allowedExtensions, relPath);
          folderInfo.subFolders.push(subFolder);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase().slice(1);
          if (allowedExtensions.length === 0 || allowedExtensions.includes(ext)) {
            const stats = await fs.stat(fullPath);
            try {
              const hash = await hashFile(fullPath);
              folderInfo.files.push({
                path: fullPath,
                size: stats.size,
                name: entry.name,
                hash: hash
              });
            } catch (err) {
              continue;
            }
          }
        }
      } catch (err) {
        continue;
      }
    }
  } catch (err) {
    return folderInfo;
  }
  
  return folderInfo;
}

async function buildDestinationFolderSignature(folderInfo) {
  const fileHashes = [];
  
  for (const file of folderInfo.files) {
    fileHashes.push({
      name: file.name,
      size: file.size,
      hash: file.hash
    });
  }
  
  fileHashes.sort((a, b) => a.name.localeCompare(b.name));
  
  const signature = crypto.createHash('sha256');
  for (const fh of fileHashes) {
    signature.update(`${fh.name}:${fh.size}:${fh.hash}`);
  }
  
  return signature.digest('hex');
}

ipcMain.handle('select-source-folders', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'multiSelections']
  });
  
  if (!result.canceled) {
    return result.filePaths;
  }
  return [];
});

ipcMain.handle('select-destination-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  
  if (!result.canceled) {
    return result.filePaths[0];
  }
  return null;
});

ipcMain.handle('start-process', async (event, sourceFolders, destinationFolder, extensions) => {
  try {
    state.paused = false;
    state.currentIndex = 0;
    state.deduplicationMap.clear();
    state.fileList = [];
    state.folderList = [];
    state.folderMap.clear();
    state.copiedFolders.clear();
    state.folderReport = [];
    state.stats = {
      scanned: 0,
      copied: 0,
      duplicates: 0,
      sizeCopied: 0
    };

    const allowedExtensions = (extensions || []).map(ext => ext.toLowerCase());

    for (const folder of sourceFolders) {
      if (state.paused) break;
      await scanDirectory(folder, state.fileList, state.folderList, allowedExtensions, '', folder);
    }

    const destinationMap = new Map();
    const destinationFolderSignatures = new Set();
    
    try {
      event.sender.send('progress-update', {
        currentFile: 'Scanning destination folder...',
        stats: { ...state.stats }
      });

      async function scanDestinationRecursive(dirPath) {
        try {
          const entries = await fs.readdir(dirPath, { withFileTypes: true });
          for (const entry of entries) {
            if (state.paused) break;
            const fullPath = path.join(dirPath, entry.name);
            try {
              if (entry.isDirectory()) {
                await scanDestinationRecursive(fullPath);
              } else if (entry.isFile()) {
                const stats = await fs.stat(fullPath);
                const hash = await hashFile(fullPath);
                const key = `${stats.size}:${hash}`;
                destinationMap.set(key, true);
              }
            } catch (err) {
              continue;
            }
          }
        } catch (err) {
        }
      }
      
      await scanDestinationRecursive(destinationFolder);
      
      try {
        const destFolders = await fs.readdir(destinationFolder, { withFileTypes: true });
        for (const entry of destFolders) {
          if (state.paused) break;
          if (entry.isDirectory()) {
            const fullPath = path.join(destinationFolder, entry.name);
            try {
              const destFolderInfo = await scanDestinationFolder(fullPath, allowedExtensions);
              const destSignature = await buildDestinationFolderSignature(destFolderInfo);
              destinationFolderSignatures.add(destSignature);
            } catch (err) {
              continue;
            }
          }
        }
      } catch (err) {
      }
    } catch (err) {
    }

    const folderGroupsByName = new Map();
    const leafFolders = state.folderList.filter(f => f.isLeaf);
    
    for (const folderInfo of leafFolders) {
      if (state.paused) break;
      
      try {
        const signature = await buildFolderSignature(folderInfo, allowedExtensions);
        if (state.paused) break;
        
        const folderName = path.basename(folderInfo.path);
        const normalizedName = normalizeFolderName(folderName);
        
        if (!folderGroupsByName.has(normalizedName)) {
          folderGroupsByName.set(normalizedName, []);
        }
        
        folderGroupsByName.get(normalizedName).push({
          signature: signature,
          folderInfo: folderInfo
        });
      } catch (err) {
        continue;
      }
    }

    for (const [normalizedName, folderGroup] of folderGroupsByName) {
      if (state.paused) break;
      
      let destFolderPath = path.join(destinationFolder, normalizedName);
      
      let fileHashMap = new Map();
      let destFolderExists = false;
      
      try {
        const stats = await fs.stat(destFolderPath);
        if (stats.isDirectory()) {
          destFolderExists = true;
          try {
            const existingFiles = await fs.readdir(destFolderPath, { recursive: true, withFileTypes: true });
            for (const entry of existingFiles) {
              if (entry.isFile()) {
                const fullPath = path.join(destFolderPath, entry.name);
                try {
                  const stats = await fs.stat(fullPath);
                  const hash = await hashFile(fullPath);
                  const key = `${stats.size}:${hash}`;
                  fileHashMap.set(key, true);
                } catch (err) {
                  continue;
                }
              }
            }
          } catch (err) {
          }
        }
      } catch (err) {
      }
      
      if (!destFolderExists) {
        try {
          await fs.mkdir(destFolderPath, { recursive: true });
        } catch (err) {
          continue;
        }
      }
      
      for (const folderData of folderGroup) {
        if (state.paused) break;
        
        const folderKey = folderData.signature.hash;
        const sourcePath = folderData.folderInfo.path;
        let status = 'Not Copied';
        
        if (destinationFolderSignatures.has(folderKey)) {
          state.copiedFolders.add(sourcePath);
          state.stats.duplicates += folderData.signature.fileCount;
          status = 'Duplicate (Exists in Destination)';
        } else {
          try {
            await mergeFolderRecursive(sourcePath, destFolderPath, fileHashMap);
            
            state.copiedFolders.add(sourcePath);
            state.stats.copied += folderData.signature.fileCount;
            state.stats.sizeCopied += folderData.signature.totalSize;
            status = 'Copied';
            
            event.sender.send('progress-update', {
              currentFile: `Folder: ${normalizedName}`,
              stats: { ...state.stats }
            });
          } catch (err) {
            status = 'Error: ' + err.message;
          }
        }
        
        state.folderReport.push({
          sourcePath: sourcePath,
          destinationPath: destFolderPath,
          status: status
        });
      }
    }

    const processedFiles = new Set();
    for (const folderPath of state.copiedFolders) {
      for (const file of state.fileList) {
        if (file.folderPath === folderPath || file.path.startsWith(folderPath + path.sep)) {
          processedFiles.add(file.path);
        }
      }
    }

    for (let i = 0; i < state.fileList.length; i++) {
      if (state.paused) {
        state.currentIndex = i;
        break;
      }

      const file = state.fileList[i];
      
      if (processedFiles.has(file.path)) {
        continue;
      }
      
      state.stats.scanned++;
      
      event.sender.send('progress-update', {
        currentFile: file.name,
        stats: { ...state.stats }
      });

      try {
        const hash = await hashFile(file.path);
        if (state.paused) {
          state.currentIndex = i;
          break;
        }

        const key = `${file.size}:${hash}`;

        if (state.deduplicationMap.has(key) || destinationMap.has(key)) {
          state.stats.duplicates++;
          continue;
        }

        state.deduplicationMap.set(key, true);

        const sourceFolderRelativePath = file.folderRelativePath || '';
        const fileName = file.name;
        
        let destFolderPath = destinationFolder;
        if (sourceFolderRelativePath && sourceFolderRelativePath !== '.') {
          const folderParts = sourceFolderRelativePath.split(path.sep).filter(p => p);
          const normalizedParts = folderParts.map(part => normalizeFolderName(part));
          destFolderPath = path.join(destinationFolder, ...normalizedParts);
        }
        
        try {
          await fs.mkdir(destFolderPath, { recursive: true });
        } catch (err) {
        }
        
        const destPath = path.join(destFolderPath, fileName);
        
        try {
          await fs.access(destPath);
          state.stats.duplicates++;
          continue;
        } catch (err) {
        }

        let uniquePath = destPath;
        let counter = 1;
        while (true) {
          try {
            await fs.access(uniquePath);
            const ext = path.extname(fileName);
            const base = path.basename(fileName, ext);
            const dir = path.dirname(uniquePath);
            uniquePath = path.join(dir, `${base}_${counter}${ext}`);
            counter++;
          } catch (err) {
            break;
          }
        }

        await fs.copyFile(file.path, uniquePath);
        state.stats.copied++;
        state.stats.sizeCopied += file.size;

        event.sender.send('progress-update', {
          currentFile: file.name,
          stats: { ...state.stats }
        });
      } catch (err) {
        continue;
      }
    }

    if (!state.paused) {
      event.sender.send('process-complete', { 
        stats: { ...state.stats },
        report: state.folderReport
      });
    }
  } catch (err) {
    event.sender.send('process-complete', { 
      stats: { ...state.stats },
      report: state.folderReport,
      error: err.message 
    });
  }
});

ipcMain.handle('pause-process', () => {
  state.paused = true;
});

async function getAllFolders(dirPath, folderList = [], parentPath = '') {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    let hasSubFolders = false;
    
    for (const entry of entries) {
      if (entry.isDirectory()) {
        hasSubFolders = true;
        const fullPath = path.join(dirPath, entry.name);
        const relativeParent = parentPath ? path.join(parentPath, path.basename(dirPath)) : path.basename(dirPath);
        await getAllFolders(fullPath, folderList, relativeParent);
      }
    }
    
    if (!hasSubFolders) {
      const folderName = path.basename(dirPath);
      folderList.push({ 
        path: dirPath, 
        name: folderName, 
        parent: path.dirname(dirPath),
        isLeaf: true
      });
    }
  } catch (err) {
  }
  return folderList;
}

ipcMain.handle('merge-folders', async (event, destinationFolder) => {
  try {
    state.paused = false;
    state.stats = {
      scanned: 0,
      copied: 0,
      duplicates: 0,
      sizeCopied: 0
    };

    event.sender.send('progress-update', {
      currentFile: 'Scanning destination folder...',
      stats: { ...state.stats }
    });

    const allFolders = await getAllFolders(destinationFolder);
    const leafFolders = allFolders.filter(f => f.isLeaf);
    const folderGroups = new Map();

    for (const folder of leafFolders) {
      if (state.paused) break;
      
      const folderName = folder.name;
      const normalizedName = normalizeFolderName(folderName);
      
      if (!folderGroups.has(normalizedName)) {
        folderGroups.set(normalizedName, []);
      }
      folderGroups.get(normalizedName).push(folder);
    }

    const foldersToMerge = [];
    for (const [normalizedName, folders] of folderGroups) {
      if (folders.length > 1) {
        const firstFolder = folders[0];
        foldersToMerge.push({ 
          name: normalizedName, 
          folders: folders, 
          parent: firstFolder.parent 
        });
      }
    }

    if (foldersToMerge.length === 0) {
      event.sender.send('merge-complete', { 
        stats: { ...state.stats },
        message: 'No duplicate folders found to merge.'
      });
      return;
    }

    const mergeRequests = foldersToMerge.map(item => ({
      name: item.name,
      count: item.folders.length,
      folders: item.folders,
      parent: item.parent
    }));

    event.sender.send('merge-confirmation', { folders: mergeRequests });

  } catch (err) {
    event.sender.send('merge-complete', { 
      stats: { ...state.stats },
      error: err.message 
    });
  }
});

ipcMain.handle('confirm-merge', async (event, destinationFolder, foldersToMerge) => {
  try {
    state.paused = false;

    for (const folderInfo of foldersToMerge) {
      if (state.paused) break;

      const normalizedName = folderInfo.name;
      const folders = folderInfo.folders;
      const firstFolder = folders[0];
      const targetFolder = firstFolder.path;
      
      event.sender.send('progress-update', {
        currentFile: `Merging folder: ${normalizedName}`,
        stats: { ...state.stats }
      });

      const fileHashMap = new Map();
      try {
        const existingFiles = await fs.readdir(targetFolder, { recursive: true, withFileTypes: true });
        for (const entry of existingFiles) {
          if (entry.isFile()) {
            const fullPath = path.join(targetFolder, entry.name);
            try {
              const stats = await fs.stat(fullPath);
              const hash = await hashFile(fullPath);
              const key = `${stats.size}:${hash}`;
              fileHashMap.set(key, true);
            } catch (err) {
              continue;
            }
          }
        }
      } catch (err) {
      }

      for (const folder of folders) {
        if (state.paused) break;
        if (folder.path === targetFolder) continue;

        try {
          await mergeFolderRecursive(folder.path, targetFolder, fileHashMap);
          await fs.rm(folder.path, { recursive: true, force: true });
        } catch (err) {
          continue;
        }
      }
    }

    event.sender.send('merge-complete', { stats: { ...state.stats } });
  } catch (err) {
    event.sender.send('merge-complete', { 
      stats: { ...state.stats },
      error: err.message 
    });
  }
});

ipcMain.handle('resume-process', async (event, sourceFolders, destinationFolder, extensions) => {
  state.paused = false;

  const allowedExtensions = (extensions || []).map(ext => ext.toLowerCase());

  const destinationMap = new Map();
  const destinationFolderSignatures = new Set();
  
  try {
    const destFiles = await fs.readdir(destinationFolder, { recursive: true, withFileTypes: true });
    for (const entry of destFiles) {
      if (entry.isFile()) {
        const fullPath = path.join(destinationFolder, entry.name);
        try {
          const stats = await fs.stat(fullPath);
          const hash = await hashFile(fullPath);
          const key = `${stats.size}:${hash}`;
          destinationMap.set(key, true);
        } catch (err) {
          continue;
        }
      }
    }
    
    const destFolders = await fs.readdir(destinationFolder, { withFileTypes: true });
    for (const entry of destFolders) {
      if (state.paused) break;
      if (entry.isDirectory()) {
        const fullPath = path.join(destinationFolder, entry.name);
        try {
          const destFolderInfo = await scanDestinationFolder(fullPath, allowedExtensions);
          const destSignature = await buildDestinationFolderSignature(destFolderInfo);
          destinationFolderSignatures.add(destSignature);
        } catch (err) {
          continue;
        }
      }
    }
  } catch (err) {
  }

  const processedFiles = new Set();
  for (const folderPath of state.copiedFolders) {
    for (const file of state.fileList) {
      if (file.folderPath === folderPath || file.path.startsWith(folderPath + path.sep)) {
        processedFiles.add(file.path);
      }
    }
  }

  for (let i = state.currentIndex; i < state.fileList.length; i++) {
    if (state.paused) {
      state.currentIndex = i;
      break;
    }

    const file = state.fileList[i];
    
    if (processedFiles.has(file.path)) {
      continue;
    }
    
    state.stats.scanned++;
    
    event.sender.send('progress-update', {
      currentFile: file.name,
      stats: { ...state.stats }
    });

    try {
      const hash = await hashFile(file.path);
      if (state.paused) {
        state.currentIndex = i;
        break;
      }

      const key = `${file.size}:${hash}`;

      if (state.deduplicationMap.has(key) || destinationMap.has(key)) {
        state.stats.duplicates++;
        continue;
      }

      state.deduplicationMap.set(key, true);

      const sourceFolderRelativePath = file.folderRelativePath || '';
      const fileName = file.name;
      
      let destFolderPath = destinationFolder;
      if (sourceFolderRelativePath && sourceFolderRelativePath !== '.') {
        const folderParts = sourceFolderRelativePath.split(path.sep);
        const normalizedParts = folderParts.map(part => normalizeFolderName(part));
        destFolderPath = path.join(destinationFolder, ...normalizedParts);
      }
      
      try {
        await fs.mkdir(destFolderPath, { recursive: true });
      } catch (err) {
      }
      
      const destPath = path.join(destFolderPath, fileName);
      
      try {
        await fs.access(destPath);
        state.stats.duplicates++;
        continue;
      } catch (err) {
      }

      let uniquePath = destPath;
      let counter = 1;
      while (true) {
        try {
          await fs.access(uniquePath);
          const ext = path.extname(fileName);
          const base = path.basename(fileName, ext);
          const dir = path.dirname(uniquePath);
          uniquePath = path.join(dir, `${base}_${counter}${ext}`);
          counter++;
        } catch (err) {
          break;
        }
      }

      await fs.copyFile(file.path, uniquePath);
      state.stats.copied++;
      state.stats.sizeCopied += file.size;

      event.sender.send('progress-update', {
        currentFile: file.name,
        stats: { ...state.stats }
      });
    } catch (err) {
      continue;
    }
  }

  if (!state.paused) {
    event.sender.send('process-complete', { 
      stats: { ...state.stats },
      report: state.folderReport
    });
  }
});

