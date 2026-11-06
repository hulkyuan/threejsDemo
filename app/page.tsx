'use client'

import { useEffect, useRef, useState } from 'react'
import { Box, RotateCcw, ScanLine, Sparkles, Upload } from 'lucide-react'
import { ModelViewer } from '@/components/model-viewer'

export default function Page() {
  const [progress, setProgress] = useState(0)
  const [modelUrl, setModelUrl] = useState('/demomodel.glb')
  const [modelName, setModelName] = useState('model.glb')
  const fileInputRef = useRef<HTMLInputElement>(null)

  // 支持两种入口：
  // /?id=<模型id> —— 从模型库跳转，仅暴露 id，文件地址由查看器内部拼接
  // /?model=<url> —— 兼容旧方式直接指定模型地址
  useEffect(() => {
    const query = new URLSearchParams(window.location.search)
    const modelId = query.get('id')
    const modelParam = query.get('model')
    if (modelId && /^[0-9a-f-]{8,64}$/i.test(modelId)) {
      setModelUrl(`/api/models/${modelId}/file`)
      setModelName(modelId)
      fetch(`/api/models/${modelId}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (data?.name) setModelName(data.name)
        })
        .catch(() => {})
    } else if (modelParam) {
      setModelUrl(modelParam)
      setModelName(decodeURIComponent(modelParam.split('/').pop() ?? '模型库模型'))
    }
  }, [])

  useEffect(() => {
    return () => {
      if (modelUrl.startsWith('blob:')) URL.revokeObjectURL(modelUrl)
    }
  }, [modelUrl])

  function handleModelSelect(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.glb')) return
    setModelUrl((current) => {
      if (current.startsWith('blob:')) URL.revokeObjectURL(current)
      return URL.createObjectURL(file)
    })
    setModelName(file.name)
    setProgress(0)
  }

  return (
    <main className="min-h-screen overflow-hidden bg-[#080d17] text-white">
      <section className="relative min-h-screen">
        <ModelViewer progress={progress / 100} modelUrl={modelUrl} />
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_42%,transparent_0%,rgba(8,13,23,0.08)_40%,rgba(8,13,23,0.72)_100%)]" />

        <header className="absolute left-0 right-0 top-0 flex items-center justify-between px-6 py-5 md:px-10 ">
          {/* <div className="flex items-center gap-3">
            <div className="grid size-9 place-items-center rounded-xl border border-cyan-300/20 bg-cyan-300/10 text-cyan-300"><Box /></div>
            <div>
              <p className="text-sm font-semibold tracking-wide">MODEL LAB</p>
              <p className="text-[10px] uppercase tracking-[0.25em] text-slate-500">Exploded view studio</p>
            </div>
          </div> */}
          <div className="flex items-center gap-2">
            <a href="/models" className="flex items-center gap-2 rounded-full border border-white/10 bg-black/30 px-3 py-1.5 text-xs text-slate-200 backdrop-blur transition hover:bg-white/10">
              模型库
            </a>
            <a href="/cbt" className="flex items-center gap-2 rounded-full border border-cyan-300/20 bg-cyan-300/10 px-3 py-1.5 text-xs text-cyan-200 transition hover:bg-cyan-300/20">
              <Sparkles /> 进入 PSD CBT 培训系统
            </a>
          </div>
        </header>

        {/* <div className="pointer-events-none absolute left-6 top-28 max-w-xs md:left-10">
          <p className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.25em] text-cyan-300"><Sparkles /> 3D 组件查看器</p>
          <h1 className="text-3xl font-semibold tracking-tight text-white md:text-5xl">探索每一个<br /><span className="text-slate-500">隐藏的组件</span></h1>
          <p className="mt-4 text-sm leading-6 text-slate-400">拖动时间轴，让模型从完整结构平滑展开为可读的爆炸图。</p>
        </div> */}

        <aside className="absolute bottom-6 left-1/2 w-[calc(100%-3rem)] -translate-x-1/2 rounded-2xl border border-white/10 bg-[#0b1422]/85 p-4 shadow-2xl backdrop-blur-xl md:bottom-10 md:w-[min(620px,calc(100%-5rem))] md:p-5">
          {/* <div className="mb-4 flex items-end justify-between">
            <div>
              <p className="text-[10px] uppercase tracking-[0.22em] text-slate-500">Exploded sequence</p>
              <p className="mt-1 text-sm font-medium text-slate-200">模型展开进度</p>
              <p className="mt-1 max-w-52 truncate text-[10px] text-slate-500" title={modelName}>当前模型：{modelName}</p>
            </div>
            <span className="font-mono text-2xl font-semibold text-cyan-300">{String(Math.round(progress)).padStart(2, '0')}<small className="ml-0.5 text-xs">%</small></span>
          </div> */}
          <div className="relative">
            <input aria-label="模型展开进度" type="range" min="0" max="100" value={progress} onChange={(event) => setProgress(Number(event.target.value))} className="explosion-slider w-full" style={{ '--value': `${progress}%` } as React.CSSProperties} />
            <div className="mt-2 flex justify-between text-[10px] text-slate-600"><span>完整模型</span><span>分解结构</span></div>
          </div>
          {/* <div className="mt-4 flex items-center justify-between border-t border-white/8 pt-3 text-xs text-slate-500">
            <span className="flex items-center gap-2"><ScanLine /> 拖动模型查看细节</span>
            <button type="button" onClick={() => setProgress(0)} className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-slate-400 transition hover:bg-white/5 hover:text-white"><RotateCcw /> 重置</button>
          </div> */}
        </aside>
      </section>
    </main>
  )
}
