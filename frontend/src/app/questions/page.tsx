"use client";

import { MessageCircleQuestion } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { PageHeader } from "@/components/page-header";
import { PixelSays } from "@/components/pixel";
import { QuestionCard } from "@/components/question-card";
import { api, type LabelClass, type Question } from "@/lib/api";

export default function QuestionsPage() {
  const [questions, setQuestions] = useState<Question[] | null>(null);
  const [classes, setClasses] = useState<LabelClass[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [bounce, setBounce] = useState(0);

  const load = useCallback(() => {
    api.questions().then((r) => setQuestions(r.questions)).catch((e) => setMessage((e as Error).message));
    api.classes().then(setClasses);
  }, []);

  useEffect(load, [load]);

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader icon={<MessageCircleQuestion />} title="Pixel's questions"
        description="Concept-level doubts: one answer here can fix dozens of images." />
      <div className="space-y-5">
        {message && <PixelSays mood="happy" size={64} bounce={bounce}>{message}</PixelSays>}
        {questions === null && <PixelSays mood="thinking" size={64}>Thinking about it…</PixelSays>}
        {questions?.length === 0 && (
          <div className="flex justify-center py-10">
            <PixelSays vertical mood="happy" size={120} className="max-w-md">
              No doubts about concepts for now. Keep going with the lessons: questions come up when I notice something odd.
            </PixelSays>
          </div>
        )}
        <div className="stagger space-y-5">
          {questions?.map((q) => (
            <QuestionCard key={q.id} q={q} classes={classes} onDone={(m) => { setMessage(m); setBounce((b) => b + 1); load(); }} />
          ))}
        </div>
      </div>
    </div>
  );
}
