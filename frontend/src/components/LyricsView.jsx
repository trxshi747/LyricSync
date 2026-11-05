import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Crosshair, Languages, Loader2 } from 'lucide-react';

const SingleMusicNote = () => (
  <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg" className="instrumental-icon">
    <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
  </svg>
);

const TRANSLATE_OPTIONS = [
  { lang: 'en', label: 'English', title: 'Translate to English' },
  { lang: 'ar', label: 'العربية', title: 'Translate to Arabic' }
];

const LyricsView = ({ lyrics, unsyncedLyrics, progressMs, isLoading, isAiFallback, onTranslate, isTranslating, activeLang, canTranslate }) => {
  const containerRef = useRef(null);
  const [isAutoScroll, setIsAutoScroll] = useState(true);
  const [pendingLang, setPendingLang] = useState(null);
  const isRtl = activeLang === 'ar';
  const directionProps = isRtl ? { dir: 'rtl', lang: 'ar' } : {};

  const handleTranslateClick = (lang) => {
    setPendingLang(lang);
    onTranslate(lang);
  };

  // Find the active lyric index based on current progress
  let activeIndex = -1;
  for (let i = 0; i < lyrics.length; i++) {
    if (progressMs >= lyrics[i].timeMs) {
      activeIndex = i;
    } else {
      break;
    }
  }

  // Scroll to active lyric
  useEffect(() => {
    if (isAutoScroll && activeIndex !== -1 && containerRef.current) {
      const container = containerRef.current;
      const activeEl = container.children[activeIndex];
      if (activeEl) {
        // Manually calculate scroll position to prevent browser from scrolling the whole page
        const scrollPos = activeEl.offsetTop - (container.clientHeight / 2) + (activeEl.clientHeight / 2);
        container.scrollTo({
          top: scrollPos,
          behavior: 'smooth'
        });
      }
    }
  }, [activeIndex, isAutoScroll]);

  // Handle manual user scrolling to pause auto-scroll
  const handleUserInteraction = () => {
    if (isAutoScroll) {
      setIsAutoScroll(false);
    }
  };

  if (isLoading) {
    return (
      <div className="loader-container">
        <div className="ai-spinner"></div>
        {isAiFallback ? (
          <div className="ai-transcribing-text">AI is transcribing this song... this may take a minute.</div>
        ) : (
          <div>Loading Lyrics...</div>
        )}
      </div>
    );
  }

  if (!lyrics || lyrics.length === 0) {
    if (unsyncedLyrics) {
      const lines = unsyncedLyrics.split('\n');
      return (
        <div className={`lyrics-container unsynced${isRtl ? ' rtl' : ''}`} {...directionProps}>
          <div className="source-badge syncing">
            Source: Genius.com (AI Syncing in background <span className="inline-spinner"></span>)
          </div>
          {lines.map((line, index) => (
            <div key={index} className="lyric-line static">
              {line || '\u00A0'}
            </div>
          ))}
        </div>
      );
    }

    return (
      <div className="loader-container">
        <div>No lyrics available for this track.</div>
      </div>
    );
  }

  return (
    <div style={{ position: 'relative', height: '100%' }}>
      <div 
        className={`lyrics-container${isRtl ? ' rtl' : ''}`}
        {...directionProps}
        ref={containerRef}
        onWheel={handleUserInteraction}
        onTouchStart={handleUserInteraction}
      >
        {lyrics.map((lyric, index) => {
          let className = 'lyric-line';
          if (index === activeIndex) className += ' active';
          else if (index < activeIndex) className += ' passed';

          return (
            <motion.div
              key={index}
              className={className}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: index * 0.05 }}
            >
              {lyric.text === '[INSTRUMENTAL]' ? (
                <SingleMusicNote />
              ) : (
                lyric.text
              )}
            </motion.div>
          );
        })}
      </div>

      <div className="lyrics-actions">
        {canTranslate && TRANSLATE_OPTIONS.map(({ lang, label, title }) => (
          <button
            key={lang}
            className={`action-btn translate-btn ${activeLang === lang ? 'active' : ''}`}
            onClick={() => handleTranslateClick(lang)}
            disabled={isTranslating}
            title={activeLang === lang ? 'Show original lyrics' : title}
          >
            {isTranslating && pendingLang === lang ? (
              <Loader2 size={20} className="spinner" />
            ) : (
              <Languages size={20} />
            )}
            <span>{label}</span>
          </button>
        ))}
        
        {!isAutoScroll && lyrics && lyrics.length > 0 && (
          <button 
            className="action-btn resume-scroll" 
            onClick={() => setIsAutoScroll(true)}
          >
            <Crosshair size={20} />
            <span>Resume</span>
          </button>
        )}
      </div>
    </div>
  );
};

export default LyricsView;
