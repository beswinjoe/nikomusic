import { PageHeader } from '@/components/PageHeader';
import { MoodCard } from '@/components/music/MoodShelf';
import { shelfHeader, shelfSection } from '@/components/shelf';
import { CORE_MOODS, EXTENDED_MOODS } from '@/data/music/recommendations';
import { seeAllGrid } from '@/pages/pageStyles';

export default function MoodsPage() {
  return (
    <div className="pb-12">
      <PageHeader title="Find Your Mood" />

      <section className={shelfSection}>
        <div className={shelfHeader}>
          <h2 className="type-headline-emphasized text-primary">Core Moods</h2>
        </div>
        <div className={seeAllGrid}>
          {CORE_MOODS.map((mood) => (
            <MoodCard key={mood.id} mood={mood} />
          ))}
        </div>
      </section>

      <section className={shelfSection}>
        <div className={shelfHeader}>
          <h2 className="type-headline-emphasized text-primary">All Moods &amp; Moments</h2>
        </div>
        <div className={seeAllGrid}>
          {EXTENDED_MOODS.map((mood) => (
            <MoodCard key={mood.id} mood={mood} />
          ))}
        </div>
      </section>
    </div>
  );
}
