import { auth } from '/assets/js/auth.js';

const uploadBtn = document.getElementById('uploadBtn');
const imageFileInput = document.getElementById('imageFile');
const uploadResult = document.getElementById('uploadResult');
const uploadError = document.getElementById('uploadError');
const uploadErrorText = document.getElementById('uploadErrorText');
const imageUrl = document.getElementById('imageUrl');
const copyBtn = document.getElementById('copyBtn');
const copyMarkdownBtn = document.getElementById('copyMarkdownBtn');

function showError(message) {
  uploadResult.classList.remove('active');
  uploadError.classList.add('active');
  uploadErrorText.textContent = message;
}

function clearStatus() {
  uploadError.classList.remove('active');
  uploadErrorText.textContent = '';
  uploadResult.classList.remove('active');
}

async function uploadImage() {
  clearStatus();

  const selectedFile = imageFileInput.files && imageFileInput.files[0];
  if (!selectedFile) {
    showError('Pick an image file first.');
    return;
  }

  const currentUser = auth.currentUser;
  if (!currentUser) {
    showError('You must be logged in to upload images.');
    return;
  }

  uploadBtn.disabled = true;
  uploadBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Uploading...';

  try {
    const idToken = await currentUser.getIdToken();

    const response = await fetch('/upload', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${idToken}`,
        'Content-Type': selectedFile.type || 'application/octet-stream'
      },
      body: selectedFile
    });

    let payload = null;
    const responseText = await response.text();
    if (responseText) {
      try {
        payload = JSON.parse(responseText);
      } catch (_error) {
        payload = null;
      }
    }

    if (!response.ok || !payload || !payload.url) {
      const fallbackError = response.status === 401
        ? 'You must be logged in to upload images.'
        : 'Upload failed';
      throw new Error((payload && payload.error) || fallbackError);
    }

    imageUrl.textContent = payload.url;
    uploadResult.classList.add('active');
  } catch (error) {
    showError(error.message || 'Upload failed');
  } finally {
    uploadBtn.disabled = false;
    uploadBtn.innerHTML = '<i class="fas fa-upload"></i> Upload to Server';
  }
}

async function copyCurrentLink() {
  if (!imageUrl.textContent) return;
  try {
    await navigator.clipboard.writeText(imageUrl.textContent);
    const originalHTML = copyBtn.innerHTML;
    copyBtn.innerHTML = '<i class="fas fa-check"></i> Copied!';
    setTimeout(() => {
      copyBtn.innerHTML = originalHTML;
    }, 1500);
  } catch (_error) {
    showError('Could not copy link. Please copy it manually.');
  }
}

async function copyMarkdown() {
  if (!imageUrl.textContent) return;
  const markdownText = `![image](${imageUrl.textContent})`;
  try {
    await navigator.clipboard.writeText(markdownText);
    const originalHTML = copyMarkdownBtn.innerHTML;
    copyMarkdownBtn.innerHTML = '<i class="fas fa-check"></i> Copied!';
    setTimeout(() => {
      copyMarkdownBtn.innerHTML = originalHTML;
    }, 1500);
  } catch (_error) {
    showError('Could not copy markdown. Please copy it manually.');
  }
}

if (uploadBtn) {
  uploadBtn.addEventListener('click', uploadImage);
}

if (copyBtn) {
  copyBtn.addEventListener('click', copyCurrentLink);
}

if (copyMarkdownBtn) {
  copyMarkdownBtn.addEventListener('click', copyMarkdown);
}
