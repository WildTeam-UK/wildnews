// Public HTML is shared by browsers and crawlers. Resolve metadata before the
// head is sent so canonical links never depend on body metadata streaming.
const nextConfig = {
  htmlLimitedBots: /.*/,
};

export default nextConfig;
