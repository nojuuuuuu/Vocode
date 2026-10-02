export async function writeProjectToDirectory(nodes, destination, loadFile) {
  for (const node of nodes) {
    if (node.type === 'folder') {
      const folder = await destination.getDirectoryHandle(node.name, { create: true });
      await writeProjectToDirectory(node.children, folder, loadFile);
    } else {
      const content = await loadFile(node.path);
      const file = await destination.getFileHandle(node.name, { create: true });
      const writer = await file.createWritable();
      try {
        await writer.write(content);
        await writer.close();
      } catch (error) {
        await writer.abort().catch(() => {});
        throw error;
      }
    }
  }
}
