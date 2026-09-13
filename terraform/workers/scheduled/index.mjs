export default {
  async scheduled(controller, env, ctx) {
    console.log(`Scheduled event received at ${controller.scheduledTime}`);
  },
};
