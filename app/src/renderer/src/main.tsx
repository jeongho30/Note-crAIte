import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ToastProvider } from './components'
import './styles/tokens.css'
import './styles/global.css'

// 끌어 놓기 칸 밖에 파일을 놓으면 브라우저가 그 파일로 이동해 버리므로 막는다
window.addEventListener('dragover', (e) => e.preventDefault())
window.addEventListener('drop', (e) => e.preventDefault())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>
)
