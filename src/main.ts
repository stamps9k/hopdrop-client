function mount_app(): void {
  const root = document.getElementById('app');
  if (!root) throw new Error('missing #app root element');
  root.textContent = 'hopdrop';
}

mount_app();