const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  selectSourceFolders: () => ipcRenderer.invoke('select-source-folders'),
  selectDestinationFolder: () => ipcRenderer.invoke('select-destination-folder'),
  startProcess: (sourceFolders, destinationFolder, extensions) => ipcRenderer.invoke('start-process', sourceFolders, destinationFolder, extensions),
  pauseProcess: () => ipcRenderer.invoke('pause-process'),
  resumeProcess: (sourceFolders, destinationFolder, extensions) => ipcRenderer.invoke('resume-process', sourceFolders, destinationFolder, extensions),
  mergeFolders: (destinationFolder) => ipcRenderer.invoke('merge-folders', destinationFolder),
  confirmMerge: (destinationFolder, foldersToMerge) => ipcRenderer.invoke('confirm-merge', destinationFolder, foldersToMerge),
  onProgressUpdate: (callback) => ipcRenderer.on('progress-update', (event, data) => callback(data)),
  onProcessComplete: (callback) => ipcRenderer.on('process-complete', (event, data) => callback(data)),
  onMergeConfirmation: (callback) => ipcRenderer.on('merge-confirmation', (event, data) => callback(data)),
  onMergeComplete: (callback) => ipcRenderer.on('merge-complete', (event, data) => callback(data))
});

