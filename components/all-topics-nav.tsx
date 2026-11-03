import { TopicNav } from '@/components/topic-nav';
import { getPopulatedPublicTopics } from '@/lib/published-stories';
import { EDITORIAL_TOPICS } from '@/lib/taxonomy';
import { operationalLog } from '@/lib/operational-log';

export async function AllTopicsNav() {
  const populatedTopics = await getPopulatedPublicTopics().catch((error: unknown) => {
    operationalLog('error', { operation: 'public_topic_navigation' }, error);
    return [...EDITORIAL_TOPICS];
  });
  const navigationTopics = EDITORIAL_TOPICS.filter((topic) => populatedTopics.includes(topic));

  if (!navigationTopics.length) return null;
  return <div className="topic-nav-shell shell"><TopicNav topics={navigationTopics} /></div>;
}
