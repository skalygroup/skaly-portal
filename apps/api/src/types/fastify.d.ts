declare module 'fastify' {
  interface FastifyRequest {
    user?: {
      staffId: string;
      supabaseUid: string;
      role: 'admin' | 'manager' | 'team_member' | 'freelancer';
      email: string;
      mfaEnrolled: boolean;
    };
  }
  interface FastifyInstance {
    verifyJwt: any; // populated by auth.plugin.ts in Sprint 1
    verifyInternalSecret: (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<void>; // populated by internalAuth.plugin.ts
  }
}
export {};
