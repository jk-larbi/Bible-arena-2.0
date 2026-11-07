import React, { useState, useEffect, useRef } from 'react';
import { LevelMap } from '../LevelMap';
import { ResultsScreen } from '../ResultsScreen';
import { LeaveGameButton } from '../LeaveGameButton';
import { AnswerFeedback, type Reveal } from '../AnswerFeedback';
import { AutoAdvanceBar } from '../AutoAdvanceBar';
import { useCountdown } from '../../hooks/useCountdown';
import {
  getLevelMap,
  startLevel,
  finishLevel,
  getLevelChallenges,
  submitChallengeAnswer,
  getOverallTotalMarks,
  CHALLENGES_PER_LEVEL,
  type LevelNode,
  type LevelResult,
} from '../../lib/levels';
import type { ChallengeItem } from '../../data/bibleContentBank';
import { ArrowUp, ArrowDown, RotateCcw } from 'lucide-react';

interface BaseGameProps {
  gameId: string;
  gameName: string;
  onBack: () => void;
  renderGame?: (
    level: number,
    attemptId: string,
    content: ChallengeItem[],
    onFinish: (attemptId: string, index: number, answer: string, duration: number) => void
  ) => React.ReactNode;
}

const QUESTION_SECONDS = 35;
const REVEAL_SECONDS = 5;

export const BaseGame: React.FC<BaseGameProps> = ({ gameId, gameName, onBack }) => {
  const [levels, setLevels] = useState<LevelNode[]>([]);
  const [loadingMap, setLoadingMap] = useState(true);
  const [attempt, setAttempt] = useState<{ attemptId: string; startIndex: number } | null>(null);
  const [level, setLevel] = useState<number | null>(null);
  const [challenges, setChallenges] = useState<ChallengeItem[]>([]);
  const [currentIdx, setCurrentIdx] = useState(0); // 0..9
  const [result, setResult] = useState<LevelResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [sessionMarks, setSessionMarks] = useState(0);
  const [totalMarks, setTotalMarks] = useState(() => getOverallTotalMarks());

  // Interactive per-mechanic state
  const [scramblePicked, setScramblePicked] = useState<number[]>([]);
  const [versePicked, setVersePicked] = useState<number[]>([]);
  const [timelineOrder, setTimelineOrder] = useState<string[]>([]);
  const [wordSearchFound, setWordSearchFound] = useState<string[]>([]);
  const [wordSearchSelection, setWordSearchSelection] = useState<{ row: number; col: number }[]>([]);
  const [crosswordAcross, setCrosswordAcross] = useState('');
  const [crosswordDown, setCrosswordDown] = useState('');
  const [matchSelectedLeft, setMatchSelectedLeft] = useState<string | null>(null);
  const [matchedPairs, setMatchedPairs] = useState<Record<string, string>>({});
  const [memoryFlipped, setMemoryFlipped] = useState<number[]>([]);
  const [memorySolved, setMemorySolved] = useState<number[]>([]);
  const [memoryCards, setMemoryCards] = useState<{ id: number; text: string; pairKey: string }[]>([]);

  const locked = useRef(false);
  const challengeStart = useRef(Date.now());

  const refreshMap = async () => {
    setLoadingMap(true);
    try {
      const nodes = await getLevelMap(gameId);
      setLevels(nodes);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingMap(false);
    }
  };

  useEffect(() => {
    refreshMap();
  }, [gameId]);

  const currentChallenge: ChallengeItem | undefined = challenges[currentIdx];

  // Reset interactive state whenever challenge changes
  useEffect(() => {
    setReveal(null);
    setScramblePicked([]);
    setVersePicked([]);
    setWordSearchFound([]);
    setWordSearchSelection([]);
    setCrosswordAcross('');
    setCrosswordDown('');
    setMatchSelectedLeft(null);
    setMatchedPairs({});
    setMemoryFlipped([]);
    setMemorySolved([]);
    locked.current = false;
    challengeStart.current = Date.now();

    if (currentChallenge) {
      if (gameId === 'bible-timeline' || gameId === 'bible-puzzles') {
        setTimelineOrder([...currentChallenge.options]);
      }
      if (gameId === 'bible-memory-challenge') {
        const pairs: { a: string; b: string }[] = currentChallenge.metadata?.memoryPairs || [];
        const deck: { id: number; text: string; pairKey: string }[] = [];
        pairs.forEach((p, idx) => {
          deck.push({ id: idx * 2, text: p.a, pairKey: `pair-${idx}` });
          deck.push({ id: idx * 2 + 1, text: p.b, pairKey: `pair-${idx}` });
        });
        // Shuffle deterministically by challenge index
        setMemoryCards(
          deck.sort((a, b) => ((a.id * 7 + currentIdx) % 5) - ((b.id * 7 + currentIdx) % 5))
        );
      }
    }
  }, [currentIdx, currentChallenge?.id, gameId]);

  async function handlePlay(lvl: number, restart: boolean) {
    setError(null);
    try {
      const [started, loadedChallenges] = await Promise.all([
        startLevel(gameId, lvl, restart),
        getLevelChallenges(gameId, lvl),
      ]);
      setAttempt(started);
      setLevel(lvl);
      setChallenges(loadedChallenges);
      setCurrentIdx(Math.min(started.startIndex, CHALLENGES_PER_LEVEL - 1));
      setResult(null);
      setReveal(null);
      setSessionMarks(0);
      setTotalMarks(getOverallTotalMarks());
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function settleAnswer(pickedAnswer: string | null) {
    if (locked.current || !attempt || !currentChallenge) return;
    locked.current = true;
    setError(null);

    const challengeToGrade = currentChallenge;
    const duration = Math.max(100, Date.now() - challengeStart.current);
    try {
      const res = await submitChallengeAnswer(
        attempt.attemptId,
        challengeToGrade.id,
        challengeToGrade.challenge_index,
        pickedAnswer ?? '',
        duration,
        challengeToGrade
      );

      setSessionMarks(res.session_marks);
      setTotalMarks(res.total_marks);

      setReveal({
        is_correct: res.is_correct,
        correct_answer: res.correct_answer,
        explanation: res.explanation,
        reference: res.reference,
        picked: pickedAnswer,
        marks_awarded: res.marks_awarded,
        is_new_marks: res.is_new_marks,
      });
    } catch (e) {
      locked.current = false;
      setError((e as Error).message);
    }
  }

  const answering = useCountdown(
    Boolean(attempt && !result && reveal === null && currentChallenge),
    QUESTION_SECONDS,
    () => settleAnswer(null),
    currentChallenge?.id ?? currentIdx
  );

  const isLastChallenge = currentIdx === CHALLENGES_PER_LEVEL - 1;

  const advancing = useCountdown(
    reveal !== null && !result,
    REVEAL_SECONDS,
    async () => {
      if (!attempt) return;
      if (isLastChallenge) {
        try {
          const finalRes = await finishLevel(attempt.attemptId);
          setResult(finalRes);
          await refreshMap();
        } catch (e) {
          setError((e as Error).message);
        }
        return;
      }
      setReveal(null);
      // Keep locked.current = true during transition to prevent race conditions or stale submissions;
      // it is unlocked safely when the next challenge mounts in useEffect([currentIdx]).
      setCurrentIdx((idx) => idx + 1);
    },
    currentIdx
  );

  if (result && level !== null) {
    const nextNode = levels.find((l) => l.level === level + 1);
    return (
      <ResultsScreen
        gameName={gameName}
        level={level}
        result={result}
        nextLevelAvailable={Boolean(nextNode?.is_published ?? level < 50)}
        onNext={() => handlePlay(level + 1, true)}
        onReplay={() => handlePlay(level, true)}
        onBack={() => {
          setResult(null);
          setAttempt(null);
          setLevel(null);
          refreshMap();
        }}
      />
    );
  }

  if (!attempt || level === null) {
    return (
      <div className="max-w-5xl mx-auto p-4 sm:p-6">
        <div className="flex items-center justify-between mb-4">
          <button
            onClick={onBack}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-white border border-[#171B24]/15 text-sm font-semibold text-[#171B24] hover:bg-[#F3EBDD] cursor-pointer"
          >
            ← Back to Game Library
          </button>
          {error && (
            <span className="text-xs font-semibold text-red-600 bg-red-50 px-3 py-1.5 rounded-lg">
              {error}
            </span>
          )}
        </div>
        {loadingMap ? (
          <div className="rounded-2xl bg-[#171B24] p-8 text-center text-[#F3EBDD]">
            Loading levels for {gameName}...
          </div>
        ) : (
          <div className="rounded-3xl overflow-hidden shadow-xl">
            <LevelMap gameName={gameName} levels={levels} onPlay={handlePlay} />
          </div>
        )}
      </div>
    );
  }

  if (!currentChallenge) {
    return (
      <div className="max-w-3xl mx-auto p-6 text-center">
        <p className="text-base font-semibold">Loading challenge {currentIdx + 1} of 10...</p>
      </div>
    );
  }

  // Render mechanic-specific interactive body
  const renderMechanicUI = () => {
    // 1. SCRIPTURE SCRAMBLE (Letter tile rearranging)
    if (gameId === 'scripture-scramble') {
      const letters = currentChallenge.options;
      const builtWord = scramblePicked.map((idx) => letters[idx]).join('');
      return (
        <div className="space-y-6">
          <div className="min-h-[64px] p-4 rounded-2xl bg-[#F3EBDD] border-2 border-dashed border-[#171B24]/20 flex flex-wrap items-center justify-center gap-2">
            {scramblePicked.length === 0 ? (
              <span className="text-sm text-[#171B24]/50">Tap scrambled letters below to spell the biblical word</span>
            ) : (
              scramblePicked.map((letterIdx, pos) => (
                <button
                  key={`picked-${pos}`}
                  disabled={reveal !== null}
                  onClick={() => setScramblePicked(scramblePicked.filter((_, i) => i !== pos))}
                  className="w-11 h-12 rounded-xl bg-[#171B24] text-white font-serif font-bold text-lg flex items-center justify-center shadow cursor-pointer"
                >
                  {letters[letterIdx]}
                </button>
              ))
            )}
          </div>

          <div className="flex flex-wrap justify-center gap-2.5">
            {letters.map((char, idx) => {
              const used = scramblePicked.includes(idx);
              return (
                <button
                  key={`pool-${idx}`}
                  disabled={used || reveal !== null}
                  onClick={() => {
                    const next = [...scramblePicked, idx];
                    setScramblePicked(next);
                    const candidate = next.map((i) => letters[i]).join('');
                    if (candidate.length === letters.length) {
                      settleAnswer(candidate);
                    }
                  }}
                  className={`w-11 h-12 rounded-xl font-serif font-bold text-lg flex items-center justify-center border transition-all cursor-pointer ${
                    used
                      ? 'bg-stone-200 text-stone-400 opacity-40 cursor-not-allowed'
                      : 'bg-white text-[#171B24] border-[#171B24]/20 hover:bg-[#D66B3D] hover:text-white shadow-sm'
                  }`}
                >
                  {char}
                </button>
              );
            })}
          </div>

          <div className="flex justify-center gap-3">
            <button
              disabled={reveal !== null || scramblePicked.length === 0}
              onClick={() => setScramblePicked([])}
              className="px-4 py-2.5 rounded-xl border border-[#171B24]/20 text-xs font-semibold hover:bg-[#F3EBDD] inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-40"
            >
              <RotateCcw className="w-3.5 h-3.5" /> Clear Letters
            </button>
            <button
              disabled={reveal !== null || builtWord.length === 0}
              onClick={() => settleAnswer(builtWord)}
              className="px-6 py-2.5 rounded-xl bg-[#D66B3D] text-white text-sm font-bold hover:bg-[#c25a2c] cursor-pointer disabled:opacity-40"
            >
              Check Word
            </button>
          </div>
        </div>
      );
    }

    // 2. VERSE BUILDER (Word tile assembly)
    if (gameId === 'verse-builder') {
      const words = currentChallenge.options;
      const builtSentence = versePicked.map((idx) => words[idx]).join(' ');
      return (
        <div className="space-y-6">
          <div className="min-h-[88px] p-4 rounded-2xl bg-[#F3EBDD] border-2 border-dashed border-[#171B24]/20 flex flex-wrap items-center justify-center gap-2">
            {versePicked.length === 0 ? (
              <span className="text-sm text-[#171B24]/50">Tap word tiles in sequence to assemble the verse</span>
            ) : (
              versePicked.map((wIdx, pos) => (
                <button
                  key={`vb-picked-${pos}`}
                  disabled={reveal !== null}
                  onClick={() => setVersePicked(versePicked.filter((_, i) => i !== pos))}
                  className="px-3.5 py-2 rounded-xl bg-[#171B24] text-white text-sm font-semibold shadow cursor-pointer"
                >
                  {words[wIdx]}
                </button>
              ))
            )}
          </div>

          <div className="flex flex-wrap justify-center gap-2">
            {words.map((word, idx) => {
              const used = versePicked.includes(idx);
              return (
                <button
                  key={`vb-pool-${idx}`}
                  disabled={used || reveal !== null}
                  onClick={() => {
                    const next = [...versePicked, idx];
                    setVersePicked(next);
                    if (next.length === words.length) {
                      settleAnswer(next.map((i) => words[i]).join(' '));
                    }
                  }}
                  className={`px-3.5 py-2.5 rounded-xl text-sm font-semibold border transition-all cursor-pointer ${
                    used
                      ? 'bg-stone-200 text-stone-400 opacity-40 cursor-not-allowed'
                      : 'bg-white text-[#171B24] border-[#171B24]/20 hover:bg-[#3156C9] hover:text-white'
                  }`}
                >
                  {word}
                </button>
              );
            })}
          </div>

          <div className="flex justify-center gap-3">
            <button
              disabled={reveal !== null || versePicked.length === 0}
              onClick={() => setVersePicked([])}
              className="px-4 py-2.5 rounded-xl border border-[#171B24]/20 text-xs font-semibold hover:bg-[#F3EBDD] cursor-pointer disabled:opacity-40"
            >
              Reset Tiles
            </button>
            <button
              disabled={reveal !== null || versePicked.length === 0}
              onClick={() => settleAnswer(builtSentence)}
              className="px-6 py-2.5 rounded-xl bg-[#D66B3D] text-white text-sm font-bold cursor-pointer disabled:opacity-40"
            >
              Submit Verse
            </button>
          </div>
        </div>
      );
    }

    // 3. BIBLE TIMELINE & BIBLE PUZZLES (Chronological / Fragment Ordering)
    if (gameId === 'bible-timeline' || gameId === 'bible-puzzles') {
      const separator = gameId === 'bible-timeline' ? ' -> ' : ' | ';
      const moveItem = (idx: number, dir: -1 | 1) => {
        const target = idx + dir;
        if (target < 0 || target >= timelineOrder.length) return;
        const copy = [...timelineOrder];
        [copy[idx], copy[target]] = [copy[target], copy[idx]];
        setTimelineOrder(copy);
      };
      return (
        <div className="space-y-4">
          <div className="space-y-2.5">
            {timelineOrder.map((item, idx) => (
              <div
                key={`${item}-${idx}`}
                className="flex items-center justify-between p-3.5 rounded-2xl bg-[#F3EBDD] border border-[#171B24]/15"
              >
                <div className="flex items-center gap-3">
                  <span className="w-7 h-7 rounded-full bg-[#171B24] text-white text-xs font-bold flex items-center justify-center">
                    {idx + 1}
                  </span>
                  <span className="font-serif font-bold text-base text-[#171B24]">{item}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    disabled={reveal !== null || idx === 0}
                    onClick={() => moveItem(idx, -1)}
                    aria-label="Move up"
                    className="p-2 rounded-lg bg-white border border-[#171B24]/15 disabled:opacity-30 cursor-pointer"
                  >
                    <ArrowUp className="w-4 h-4" />
                  </button>
                  <button
                    disabled={reveal !== null || idx === timelineOrder.length - 1}
                    onClick={() => moveItem(idx, 1)}
                    aria-label="Move down"
                    className="p-2 rounded-lg bg-white border border-[#171B24]/15 disabled:opacity-30 cursor-pointer"
                  >
                    <ArrowDown className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
          <button
            disabled={reveal !== null}
            onClick={() => settleAnswer(timelineOrder.join(separator))}
            className="w-full min-h-[48px] rounded-xl bg-[#D66B3D] text-white font-bold text-base hover:bg-[#c25a2c] cursor-pointer"
          >
            {gameId === 'bible-timeline' ? 'Verify Chronological Order' : 'Assemble Sacred Mosaic'}
          </button>
        </div>
      );
    }

    // 4. BIBLE WORD SEARCH (Select adjacent letters to find each hidden word)
    if (gameId === 'bible-word-search') {
      const targetWords: string[] = currentChallenge.metadata?.words || currentChallenge.options;
      const cleanWord = (value: string) => value.toUpperCase().replace(/[^A-Z]/g, '');
      const words = targetWords.map(cleanWord).filter(Boolean);
      const columns = Math.max(12, ...words.map((word) => word.length));
      const grid = words.map((word, row) => {
        const cells = Array.from({ length: columns }, (_, col) =>
          'ABCDEFGHJKLMNPQRSTUVWXYZ'[(row * 11 + col * 7 + 3) % 24]
        );
        const start = (row * 3) % Math.max(1, columns - word.length + 1);
        [...word].forEach((letter, offset) => { cells[start + offset] = letter; });
        return cells;
      });
      const selectCell = (row: number, col: number) => {
        if (reveal !== null) return;
        const previous = wordSearchSelection[wordSearchSelection.length - 1];
        if (previous && (previous.row !== row || Math.abs(previous.col - col) !== 1)) {
          setWordSearchSelection([{ row, col }]);
          return;
        }
        if (wordSearchSelection.some((cell) => cell.row === row && cell.col === col)) return;
        const next = [...wordSearchSelection, { row, col }];
        const candidate = next.map(({ row: r, col: c }) => grid[r][c]).join('');
        const match = targetWords.find((word) => {
          const normalized = cleanWord(word);
          return !wordSearchFound.includes(word) &&
            (candidate === normalized || candidate === [...normalized].reverse().join(''));
        });
        if (match) {
          const found = [...wordSearchFound, match];
          setWordSearchFound(found);
          setWordSearchSelection([]);
          if (found.length === targetWords.length) settleAnswer(targetWords.join(','));
          return;
        }
        setWordSearchSelection(next);
      };
      return (
        <div className="space-y-5">
          <div className="flex flex-wrap gap-2 justify-center">
            {targetWords.map((word) => {
              const found = wordSearchFound.includes(word);
              return (
                <span
                  key={word}
                  className={`px-3 py-2 rounded-xl font-mono text-sm font-bold border ${
                    found
                      ? 'bg-emerald-700 text-white border-emerald-700 line-through'
                      : 'bg-[#F3EBDD] text-[#171B24] border-[#171B24]/20'
                  }`}
                >
                  {found ? `✓ ${word}` : word}
                </span>
              );
            })}
          </div>
          <div className="bg-[#171B24] text-[#F3EBDD] p-4 rounded-2xl font-mono text-center select-none overflow-x-auto">
            <div className="inline-grid gap-1.5" style={{ gridTemplateColumns: `repeat(${columns}, minmax(1.8rem, 1fr))` }}>
              {grid.flatMap((row, rowIdx) =>
                row.map((letter, colIdx) => {
                  const selected = wordSearchSelection.some((cell) => cell.row === rowIdx && cell.col === colIdx);
                  return (
                    <button
                      key={`${rowIdx}-${colIdx}`}
                      type="button"
                      disabled={reveal !== null || wordSearchFound.length === targetWords.length}
                      onClick={() => selectCell(rowIdx, colIdx)}
                      aria-label={`Row ${rowIdx + 1}, column ${colIdx + 1}, ${letter}`}
                      className={`w-7 h-8 sm:w-8 sm:h-9 rounded flex items-center justify-center font-bold text-sm transition-colors ${
                        selected ? 'bg-[#D66B3D] text-white' : 'bg-white/10 hover:bg-white/25'
                      }`}
                    >
                      {letter}
                    </button>
                  );
                })
              )}
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-[#5A6275]">
              Select adjacent letters in a row, forwards or backwards, to find each word
            </p>
            <button
              type="button"
              disabled={wordSearchSelection.length === 0 || reveal !== null}
              onClick={() => setWordSearchSelection([])}
              className="shrink-0 px-3 py-2 rounded-lg border border-[#171B24]/20 text-xs font-semibold disabled:opacity-40"
            >
              Clear selection
            </button>
          </div>
          <p className="text-xs text-center text-[#5A6275]">
            {wordSearchFound.length} of {targetWords.length} words found
          </p>
        </div>
      );
    }

    // 5. BIBLE CROSSWORD (Intersecting Across & Down Clues)
    if (gameId === 'bible-crossword') {
      const acrossAns: string = currentChallenge.metadata?.acrossAnswer || currentChallenge.options[0] || '';
      const downAns: string = currentChallenge.metadata?.downAnswer || currentChallenge.options[1] || '';
      return (
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="p-4 rounded-2xl bg-[#F3EBDD] border border-[#171B24]/15">
              <label className="block text-xs font-bold uppercase text-[#D66B3D] mb-1">
                Across ({acrossAns.length} letters)
              </label>
              <p className="text-xs text-[#171B24]/80 mb-2">{currentChallenge.metadata?.acrossClue}</p>
              <input
                type="text"
                disabled={reveal !== null}
                value={crosswordAcross}
                onChange={(e) => setCrosswordAcross(e.target.value.toUpperCase())}
                placeholder="Enter across answer..."
                className="w-full px-3 py-2 rounded-xl bg-white border border-[#171B24]/20 font-mono uppercase font-bold"
              />
            </div>
            <div className="p-4 rounded-2xl bg-[#F3EBDD] border border-[#171B24]/15">
              <label className="block text-xs font-bold uppercase text-[#3156C9] mb-1">
                Down ({downAns.length} letters)
              </label>
              <p className="text-xs text-[#171B24]/80 mb-2">{currentChallenge.metadata?.downClue}</p>
              <input
                type="text"
                disabled={reveal !== null}
                value={crosswordDown}
                onChange={(e) => setCrosswordDown(e.target.value.toUpperCase())}
                placeholder="Enter down answer..."
                className="w-full px-3 py-2 rounded-xl bg-white border border-[#171B24]/20 font-mono uppercase font-bold"
              />
            </div>
          </div>
          <div className="flex justify-end items-center">
            <button
              type="button"
              disabled={reveal !== null || !crosswordAcross.trim() || !crosswordDown.trim()}
              onClick={() => settleAnswer(`${crosswordAcross.trim()}|${crosswordDown.trim()}`)}
              className="px-6 py-2.5 rounded-xl bg-[#D66B3D] text-white font-bold text-sm cursor-pointer disabled:opacity-40"
            >
              Submit Crossword
            </button>
          </div>
        </div>
      );
    }

    // 6. BIBLE MATCH-UP (Pair matching)
    if (gameId === 'bible-match-up') {
      const pairs: { left: string; right: string }[] = currentChallenge.metadata?.pairs || [];
      const leftItems = pairs.map((p) => p.left);
      const rightItems = pairs.map((p) => p.right);
      return (
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-2">
              <span className="text-xs font-bold uppercase text-[#5A6275]">1. Select Biblical Figure</span>
              {leftItems.map((left) => {
                const isMatched = Boolean(matchedPairs[left]);
                const isSelected = matchSelectedLeft === left;
                return (
                  <button
                    key={left}
                    disabled={reveal !== null || isMatched}
                    onClick={() => setMatchSelectedLeft(left)}
                    className={`w-full p-3 rounded-xl text-left text-sm font-bold border transition-all cursor-pointer ${
                      isMatched
                        ? 'bg-emerald-100 border-emerald-600 text-emerald-900'
                        : isSelected
                        ? 'bg-[#3156C9] text-white border-[#3156C9]'
                        : 'bg-white border-[#171B24]/15 hover:bg-[#F3EBDD]'
                    }`}
                  >
                    {left} {isMatched && '✓'}
                  </button>
                );
              })}
            </div>
            <div className="space-y-2">
              <span className="text-xs font-bold uppercase text-[#5A6275]">2. Match Defining Act</span>
              {rightItems.map((right) => {
                const alreadyUsed = Object.values(matchedPairs).includes(right);
                return (
                  <button
                    key={right}
                    disabled={reveal !== null || alreadyUsed || !matchSelectedLeft}
                    onClick={() => {
                      if (!matchSelectedLeft) return;
                      const next = { ...matchedPairs, [matchSelectedLeft]: right };
                      setMatchedPairs(next);
                      setMatchSelectedLeft(null);
                      if (Object.keys(next).length === pairs.length) {
                        const formatted = pairs.map((p) => `${p.left}=${next[p.left]}`).join('|');
                        settleAnswer(formatted);
                      }
                    }}
                    className={`w-full p-3 rounded-xl text-left text-xs font-semibold border transition-all cursor-pointer ${
                      alreadyUsed
                        ? 'bg-stone-100 text-stone-400 border-stone-200'
                        : 'bg-[#F3EBDD] border-[#171B24]/15 hover:bg-[#D66B3D] hover:text-white'
                    }`}
                  >
                    {right}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      );
    }

    // 7. BIBLE MEMORY CHALLENGE (Flip-card pair matching)
    if (gameId === 'bible-memory-challenge' && memoryCards.length > 0) {
      return (
        <div className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {memoryCards.map((card, idx) => {
              const isSolved = memorySolved.includes(idx);
              const isFlipped = memoryFlipped.includes(idx) || isSolved;
              return (
                <button
                  key={card.id}
                  disabled={reveal !== null || isFlipped || memoryFlipped.length >= 2}
                  onClick={() => {
                    const nextFlipped = [...memoryFlipped, idx];
                    setMemoryFlipped(nextFlipped);
                    if (nextFlipped.length === 2) {
                      const [firstIdx, secondIdx] = nextFlipped;
                      if (memoryCards[firstIdx].pairKey === memoryCards[secondIdx].pairKey) {
                        const nextSolved = [...memorySolved, firstIdx, secondIdx];
                        setMemorySolved(nextSolved);
                        setMemoryFlipped([]);
                        if (nextSolved.length === memoryCards.length) {
                          settleAnswer(currentChallenge.correct_answer);
                        }
                      } else {
                        setTimeout(() => setMemoryFlipped([]), 700);
                      }
                    }
                  }}
                  className={`min-h-[80px] p-3 rounded-2xl font-serif font-bold text-sm border transition-all flex items-center justify-center text-center cursor-pointer ${
                    isSolved
                      ? 'bg-emerald-700 text-white border-emerald-700'
                      : isFlipped
                      ? 'bg-[#3156C9] text-white border-[#3156C9]'
                      : 'bg-[#F3EBDD] text-[#171B24] border-[#171B24]/20 hover:bg-[#D66B3D] hover:text-white'
                  }`}
                >
                  {isFlipped ? card.text : '✦ Tap to Flip'}
                </button>
              );
            })}
          </div>
        </div>
      );
    }

    // 8. Biblical Record Scenarios + Multiple Choice / Standard Games
    const scenarioPoints: string[] | undefined = currentChallenge.metadata?.clues;
    return (
      <div className="space-y-5">
        {scenarioPoints && scenarioPoints.length > 0 && (
          <div className="space-y-2 bg-[#F3EBDD] p-4 rounded-2xl border border-[#171B24]/15">
            <span className="text-xs font-bold uppercase tracking-wider text-[#171B24]/70">
              Biblical Record &amp; Testimony
            </span>
            {scenarioPoints.map((point, idx) => (
              <p key={idx} className="text-sm text-[#171B24] font-medium">
                • {point}
              </p>
            ))}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
          {currentChallenge.options.map((opt) => {
            let btnStyle =
              'bg-[#F3EBDD] text-[#171B24] border-[#171B24]/15 hover:bg-[#D66B3D] hover:text-white';
            if (reveal !== null) {
              if (opt.toLowerCase() === reveal.correct_answer.toLowerCase()) {
                btnStyle = 'bg-emerald-600 text-white border-emerald-600 font-bold';
              } else if (opt === reveal.picked && !reveal.is_correct) {
                btnStyle = 'bg-rose-600 text-white border-rose-600';
              } else {
                btnStyle = 'bg-stone-100 text-stone-400 opacity-50';
              }
            }
            return (
              <button
                key={opt}
                disabled={reveal !== null}
                onClick={() => settleAnswer(opt)}
                className={`min-h-[52px] p-4 rounded-2xl font-semibold text-left border transition-all cursor-pointer disabled:cursor-default ${btnStyle}`}
              >
                {opt}
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div className="max-w-4xl mx-auto p-4 sm:p-6 text-[#171B24]">
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <LeaveGameButton
          exitTo="/"
          onLeave={() => {
            setAttempt(null);
            setLevel(null);
            refreshMap();
          }}
        />
        <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
          <div className="px-3.5 py-1.5 rounded-xl bg-[#D66B3D] text-white text-xs font-bold shadow-sm flex items-center gap-1.5">
            <span>Marks:</span>
            <span className="tabular-nums text-sm">{sessionMarks} / 100</span>
          </div>
          <div className="px-3 py-1.5 rounded-xl bg-[#171B24] text-[#F3EBDD] text-xs font-bold flex items-center gap-1.5">
            <span className="text-[#A7B49A]">Career:</span>
            <span className="tabular-nums">{totalMarks}</span>
          </div>
          <span className="px-3 py-1.5 rounded-full bg-[#171B24]/10 text-[#171B24] text-xs font-bold">
            Level {level} • Q{currentIdx + 1}/{CHALLENGES_PER_LEVEL}
          </span>
          {reveal === null && (
            <span className="tabular-nums font-mono text-[#D66B3D] font-bold text-sm sm:text-base">
              ⏱ {answering.secondsLeft}s
            </span>
          )}
        </div>
      </div>

      <div className="bg-white rounded-3xl p-6 sm:p-8 shadow-xl border border-[#171B24]/10">
        <div className="flex items-center justify-between mb-4">
          <span className="text-xs font-bold uppercase tracking-wider text-[#D66B3D]">
            {gameName} • Level {level}
          </span>
        </div>

        <h2
          className={`font-serif font-bold text-[#171B24] mb-6 ${
            gameId === 'guess-the-emoji' ? 'text-4xl sm:text-6xl text-center py-6 bg-[#171B24] rounded-2xl text-white' : 'text-xl sm:text-2xl'
          }`}
        >
          {currentChallenge.question_text}
        </h2>

        {renderMechanicUI()}

        {error && (
          <p className="mt-4 text-sm text-red-600 font-semibold" role="alert">
            {error}
          </p>
        )}

        {reveal && (
          <div className="mt-6">
            <AnswerFeedback r={reveal} />
            <AutoAdvanceBar
              progress={advancing.progress}
              secondsLeft={advancing.secondsLeft}
              isLast={isLastChallenge}
            />
          </div>
        )}
      </div>
    </div>
  );
};
